import Folder from '../../models/Folder';
import Note from '../../models/Note';
import Resource from '../../models/Resource';
import Setting from '../../models/Setting';
import shim from '../../shim';
import { db, encryptionService, fileContentEqual, setupDatabaseAndSynchronizer, supportDir, switchClient } from '../../testing/test-utils';
import { NoteEntity, ResourceEntity, ResourceOcrStatus } from '../database/types';
import EncryptionService from '../e2ee/EncryptionService';
import ResourceService from '../ResourceService';
import SearchEngine from '../search/SearchEngine';
import bulkSetNoteLockState from './bulkSetNoteLockState';
import NoteLockKey from './NoteLockKey';
import NoteLockResource from './NoteLockResource';
import NoteLockService from './NoteLockService';
import NoteLockSession from './NoteLockSession';

// Resolves with the banner actions once the background run that the next save starts is done.
const backgroundRun = () => new Promise<unknown[]>(resolve => {
	const dispatch = NoteLockResource.dispatch;
	const actions: unknown[] = [];
	NoteLockResource.dispatch = (action => {
		actions.push(action);
		if (action.value === false) {
			NoteLockResource.dispatch = dispatch;
			resolve(actions);
		}
		return action;
	}) as typeof dispatch;
});

// The note screen's save after a lock change.
const lockNote = async (note: NoteEntity, isLocked: boolean) => {
	const loaded = await Note.load(note.id, { useNoteLock: true });
	const done = backgroundRun();
	const saved = await Note.save({ ...loaded, is_locked: isLocked ? 1 : 0 }, { useNoteLock: true });
	await done;
	return saved;
};

const noteWithAttachment = async () => {
	const note = await shim.attachFileToNote(await Note.save({ title: 'note' }), `${supportDir}/photo.jpg`);
	const resource: ResourceEntity = (await Resource.all())[0];
	return { note, resource };
};

const fileHeader = async (resource: ResourceEntity) => {
	return (await shim.fsDriver().readFile(Resource.fullPath(resource), 'Buffer') as Buffer).subarray(0, 5).toString('ascii');
};

describe('NoteLockResource', () => {

	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
		NoteLockKey.destroyInstance();
		NoteLockSession.destroyInstance();
		NoteLockService.destroyInstance();
		EncryptionService.instance_ = encryptionService();
		Setting.setValue('featureFlag.noteLock', true);
		await NoteLockKey.instance().create('123456');
		await NoteLockSession.instance().unlock('123456');
	});

	it('should encrypt the attachment file when the note is locked and decrypt it when the lock is removed', async () => {
		const { note, resource } = await noteWithAttachment();
		await Resource.save({ id: resource.id, ocr_status: ResourceOcrStatus.Done, ocr_text: 'secret text', ocr_details: '[]' });
		const searchEngine = new SearchEngine();
		searchEngine.setDb(db());
		const indexedText = async () => (await db().selectOne('SELECT body FROM items_normalized WHERE item_id = ?', [resource.id]))?.body;
		await searchEngine.syncTables();
		expect(await indexedText()).toBe('secret text');

		await lockNote(note, true);
		const locked = await Resource.load(resource.id);
		expect(locked.is_locked).toBe(1);
		expect(locked.ocr_text).toBe('');
		expect(locked.ocr_details).toBe('');
		expect(locked.ocr_status).toBe(ResourceOcrStatus.Todo);
		expect(locked.blob_updated_time).toBeGreaterThan(resource.blob_updated_time);
		expect(await fileHeader(locked)).toBe('JLD01');
		await searchEngine.syncTables();
		expect(await indexedText()).toBeUndefined();
		expect(await Resource.needOcr(['image/jpeg'], [], 100, { fields: ['id'] })).toEqual([]);

		await lockNote(note, false);
		const unlocked = await Resource.load(resource.id);
		expect(unlocked.is_locked).toBe(0);
		expect(fileContentEqual(Resource.fullPath(unlocked), `${supportDir}/photo.jpg`)).toBe(true);
	});

	it('should show the banner while the attachments change', async () => {
		const { note } = await noteWithAttachment();
		const loaded = await Note.load(note.id, { useNoteLock: true });
		const done = backgroundRun();
		await Note.save({ ...loaded, is_locked: 1 }, { useNoteLock: true });
		expect(await done).toEqual([
			{ type: 'NOTE_LOCK_RESOURCE_CHANGE_RUNNING_SET', value: true },
			{ type: 'NOTE_LOCK_RESOURCE_CHANGE_RUNNING_SET', value: false },
		]);
	});

	it('should not encrypt an attachment that an unlocked note also uses, and count it for the confirmation', async () => {
		const { note, resource } = await noteWithAttachment();
		await Note.save({ title: 'other', body: Resource.markdownTag(resource) });
		await ResourceService.instance().indexNoteResources();
		expect(await NoteLockResource.sharedResourceCount(note.id, true)).toBe(1);

		await lockNote(note, true);

		expect((await Resource.load(resource.id)).is_locked).toBe(0);
		expect(fileContentEqual(Resource.fullPath(resource), `${supportDir}/photo.jpg`)).toBe(true);
	});

	it('should decrypt an attachment that another locked note uses when the lock is removed, and count it for the confirmation', async () => {
		const { note, resource } = await noteWithAttachment();
		const other = await Note.save({ title: 'other', body: Resource.markdownTag(resource) });
		await ResourceService.instance().indexNoteResources();
		await lockNote(note, true);
		await lockNote(other, true);
		expect((await Resource.load(resource.id)).is_locked).toBe(1);
		expect(await NoteLockResource.sharedResourceCount(note.id, false)).toBe(1);

		await lockNote(note, false);

		expect((await Resource.load(resource.id)).is_locked).toBe(0);
		expect(fileContentEqual(Resource.fullPath(resource), `${supportDir}/photo.jpg`)).toBe(true);
	});

	it('should encrypt an attachment added to a note that is already locked', async () => {
		const note = await lockNote(await Note.save({ title: 'note', body: 'secret' }), true);
		const resource = await shim.createResourceFromPath(`${supportDir}/photo.jpg`);

		const done = backgroundRun();
		await Note.save({ ...note, body: `secret ${Resource.markdownTag(resource)}` }, { useNoteLock: true });
		await done;

		expect((await Resource.load(resource.id)).is_locked).toBe(1);
		expect(await fileHeader(resource)).toBe('JLD01');
	});

	it('should not encrypt a file twice when a previous run stopped before saving the lock state', async () => {
		const { note, resource } = await noteWithAttachment();
		const path = Resource.fullPath(resource);
		await NoteLockService.withDecryptedKey(scoped => scoped.encryptFile(path, `${path}.tmp`));
		await shim.fsDriver().move(`${path}.tmp`, path);

		await lockNote(note, true);
		await lockNote(note, false);

		expect(fileContentEqual(path, `${supportDir}/photo.jpg`)).toBe(true);
	});

	it('should not share a locked attachment', async () => {
		const { note, resource } = await noteWithAttachment();
		await lockNote(note, true);

		const folder = await Folder.save({ title: 'shared', share_id: 'share1' });
		await Note.save({ id: note.id, parent_id: folder.id, share_id: 'share1' });
		await ResourceService.instance().indexNoteResources();
		await Folder.updateResourceShareIds(ResourceService.instance());
		expect((await Resource.load(resource.id)).share_id).toBe('');
	});

	it('should lock the attachments during a bulk lock before it returns', async () => {
		const { note, resource } = await noteWithAttachment();

		const result = await bulkSetNoteLockState([note.id], true);

		expect(result).toMatchObject({ changed: 1, failed: 0, failedResources: 0 });
		expect((await Resource.load(resource.id)).is_locked).toBe(1);
		expect(await fileHeader(resource)).toBe('JLD01');
	});
});
