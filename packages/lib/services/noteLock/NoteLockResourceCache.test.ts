import Note from '../../models/Note';
import Resource from '../../models/Resource';
import Setting from '../../models/Setting';
import shim from '../../shim';
import { msleep } from '@joplin/utils/time';
import eventManager, { EventName } from '../../eventManager';
import { encryptionService, fileContentEqual, setupDatabaseAndSynchronizer, supportDir, switchClient } from '../../testing/test-utils';
import { ResourceEntity } from '../database/types';
import EncryptionService from '../e2ee/EncryptionService';
import attachedResources, { clearResourceCache } from '../../utils/attachedResources';
import NoteLockKey from './NoteLockKey';
import NoteLockResource from './NoteLockResource';
import NoteLockResourceCache from './NoteLockResourceCache';
import NoteLockService from './NoteLockService';
import NoteLockSession from './NoteLockSession';
import noteLockResourceInfos from './noteLockResourceInfos';

// A locked note with an attachment, as left by the note screen's save and the background run after it.
const lockedNoteWithAttachment = async () => {
	const note = await shim.attachFileToNote(await Note.save({ title: 'note' }), `${supportDir}/photo.jpg`);
	await Note.save({ ...await Note.load(note.id, { useNoteLock: true }), is_locked: 1 }, { useNoteLock: true });
	await NoteLockResource.update(note.id);
	const resource: ResourceEntity = await Resource.load((await Resource.all())[0].id);
	return { note: await Note.load(note.id), resource };
};

describe('NoteLockResourceCache', () => {

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
		await NoteLockResourceCache.clear();
		clearResourceCache();
	});

	it('should decrypt a locked attachment to a copy inside the resource directory, and reuse it', async () => {
		const { resource } = await lockedNoteWithAttachment();
		expect(resource.is_locked).toBe(1);
		expect(NoteLockResourceCache.isReady(resource)).toBe(false);

		const path = await NoteLockResourceCache.load(resource);

		expect(path).toBe(`${Setting.value('resourceDir')}/${NoteLockResourceCache.relativePath(resource)}`);
		expect(fileContentEqual(path, `${supportDir}/photo.jpg`)).toBe(true);
		expect(fileContentEqual(Resource.fullPath(resource), `${supportDir}/photo.jpg`)).toBe(false);
		expect(NoteLockResourceCache.isReady(resource)).toBe(true);
		const decryptFile = jest.spyOn(NoteLockService.prototype, 'decryptFile');
		expect(await NoteLockResourceCache.load(resource)).toBe(path);
		expect(decryptFile).not.toHaveBeenCalled();
		decryptFile.mockRestore();
	});

	it('should give the plain file to open, save or share, and need the session for a locked one', async () => {
		const { resource } = await lockedNoteWithAttachment();
		const plain = await shim.createResourceFromPath(`${supportDir}/photo.jpg`);

		expect(await NoteLockResourceCache.plainPath(plain)).toBe(Resource.fullPath(plain));
		expect(fileContentEqual(await NoteLockResourceCache.plainPath(resource), `${supportDir}/photo.jpg`)).toBe(true);

		NoteLockSession.instance().lock();
		await NoteLockResourceCache.clear();
		await expect(NoteLockResourceCache.plainPath(resource)).rejects.toThrow();
	});

	it('should remove the copies when the session locks', async () => {
		await NoteLockResourceCache.initialize();
		const { resource } = await lockedNoteWithAttachment();
		const path = await NoteLockResourceCache.load(resource);

		NoteLockSession.instance().lock();
		for (let i = 0; i < 50 && await shim.fsDriver().exists(path); i++) await msleep(20);

		expect(await shim.fsDriver().exists(path)).toBe(false);
		expect(NoteLockResourceCache.isReady(resource)).toBe(false);
	});

	it('should abandon a decryption when the note is left', async () => {
		const { resource } = await lockedNoteWithAttachment();

		const loading = NoteLockResourceCache.load(resource);
		NoteLockResourceCache.cancelLoading();

		await expect(loading).rejects.toThrow('Note lock decryption was cancelled');
		expect(NoteLockResourceCache.isReady(resource)).toBe(false);
		expect(await shim.fsDriver().exists(NoteLockResourceCache.path(resource))).toBe(false);
	});

	it('should tell the viewers how to show locked attachments and start decrypting them', async () => {
		const { note, resource } = await lockedNoteWithAttachment();
		const decrypted = new Promise<string>(resolve => eventManager.once(EventName.NoteLockResourceDecrypted, event => resolve(event.id)));

		const infos = noteLockResourceInfos(await attachedResources(`![](:/${resource.id})`), true);
		expect(infos[resource.id].noteLock).toEqual({ path: undefined, sessionLocked: false, mismatch: false });
		expect(await decrypted).toBe(resource.id);
		expect(noteLockResourceInfos(await attachedResources(`![](:/${resource.id})`), true)[resource.id].noteLock.path).toBe(NoteLockResourceCache.relativePath(resource));

		// Shown in a note that is not locked, while the session is locked.
		NoteLockSession.instance().lock();
		await NoteLockResourceCache.clear();
		expect(noteLockResourceInfos(await attachedResources(`![](:/${resource.id})`), false)[resource.id].noteLock).toEqual({ path: undefined, sessionLocked: true, mismatch: true });
		expect(note.is_locked).toBe(1);
	});

	it('should map the decrypted copy of a locked attachment for the Rich Text editor, and back', async () => {
		const { resource } = await lockedNoteWithAttachment();
		await NoteLockResourceCache.load(resource);
		const body = `![](:/${resource.id})`;

		const html = await Note.replaceResourceInternalToExternalLinks(body, { useAbsolutePaths: true });
		expect(html).toContain(NoteLockResourceCache.relativePath(resource));

		expect(await Note.replaceResourceExternalToInternalLinks(html, { useAbsolutePaths: true })).toBe(body);
	});
});
