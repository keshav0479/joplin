import Setting from '../../models/Setting';
import Note from '../../models/Note';
import Folder from '../../models/Folder';
import { NoteEntity } from '../database/types';
import { encryptionService, setupDatabaseAndSynchronizer, switchClient, afterAllCleanUp } from '../../testing/test-utils';
import EncryptionService from '../e2ee/EncryptionService';
import NoteLockKey from './NoteLockKey';
import NoteLockService from './NoteLockService';
import NoteLockSession from './NoteLockSession';
import bulkSetNoteLockState from './bulkSetNoteLockState';

const setUpUnlockedSession = async (password = '123456') => {
	await NoteLockKey.instance().create(password);
	await NoteLockSession.instance().unlock(password);
};

const createLockedNote = async (props: NoteEntity) => {
	return Note.save({ ...props, is_locked: 1 }, { useNoteLock: true });
};

describe('bulkSetNoteLockState', () => {

	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
		NoteLockService.destroyInstance();
		NoteLockSession.destroyInstance();
		NoteLockKey.destroyInstance();
		EncryptionService.instance_ = encryptionService();
		Setting.setValue('featureFlag.noteLock', true);
	});

	afterAll(async () => {
		await afterAllCleanUp();
	});

	it('should lock the notes in the folder and its subfolders', async () => {
		await setUpUnlockedSession();
		const folder = await Folder.save({ title: 'folder' });
		const subFolder = await Folder.save({ title: 'sub', parent_id: folder.id });
		const otherFolder = await Folder.save({ title: 'other' });
		const note1 = await Note.save({ title: 'one', body: 'secret one', parent_id: folder.id });
		const note2 = await Note.save({ title: 'two', body: 'secret two', parent_id: subFolder.id });
		const alreadyLocked = await createLockedNote({ title: 'locked', body: 'secret locked', parent_id: folder.id });
		const otherNote = await Note.save({ title: 'out', body: 'out of scope', parent_id: otherFolder.id });

		const result = await bulkSetNoteLockState(folder.id, true);

		expect(result).toEqual({ changed: 2, skipped: 1, failed: 0 });
		expect((await Note.load(note1.id)).body).not.toBe('secret one');
		expect((await Note.load(note2.id)).body).not.toBe('secret two');
		for (const id of [note1.id, note2.id, alreadyLocked.id]) {
			expect((await Note.load(id)).is_locked).toBe(1);
		}
		expect((await Note.load(otherNote.id)).is_locked).toBe(0);
	});

	it('should unlock the notes in the folder and its subfolders', async () => {
		await setUpUnlockedSession();
		const folder = await Folder.save({ title: 'folder' });
		const subFolder = await Folder.save({ title: 'sub', parent_id: folder.id });
		const note1 = await createLockedNote({ title: 'one', body: 'secret one', parent_id: folder.id });
		const note2 = await createLockedNote({ title: 'two', body: 'secret two', parent_id: subFolder.id });
		const plainNote = await Note.save({ title: 'plain', body: 'already plain', parent_id: folder.id });

		const result = await bulkSetNoteLockState(folder.id, false);

		expect(result).toEqual({ changed: 2, skipped: 1, failed: 0 });
		expect((await Note.load(note1.id)).body).toBe('secret one');
		expect((await Note.load(note2.id)).body).toBe('secret two');
		expect((await Note.load(note1.id)).is_locked).toBe(0);
		expect((await Note.load(plainNote.id)).body).toBe('already plain');
	});

	test.each([
		['lock', false, true],
		['unlock', true, false],
	])('should still %s the remaining notes when the session locks mid-run', async (_label, startLocked, target) => {
		await setUpUnlockedSession();
		const folder = await Folder.save({ title: 'folder' });
		const makeNote = (props: NoteEntity) => startLocked ? createLockedNote(props) : Note.save(props);
		const note1 = await makeNote({ title: 'one', body: 'secret one', parent_id: folder.id });
		const note2 = await makeNote({ title: 'two', body: 'secret two', parent_id: folder.id });

		const originalSave = Note.save.bind(Note);
		const spy = jest.spyOn(Note, 'save').mockImplementation(async (note, options) => {
			const saved = await originalSave(note, options);
			NoteLockSession.instance().lock();
			return saved;
		});
		try {
			const result = await bulkSetNoteLockState(folder.id, target);
			expect(result).toEqual({ changed: 2, skipped: 0, failed: 0 });
		} finally {
			spy.mockRestore();
		}
		for (const id of [note1.id, note2.id]) {
			expect((await Note.load(id)).is_locked).toBe(target ? 1 : 0);
		}
	});

	it('should count a note whose save fails and leave it locked', async () => {
		await setUpUnlockedSession();
		const folder = await Folder.save({ title: 'folder' });
		// A null byte in the plaintext body makes the unlocked save fail validation (PR #15485).
		const badNote = await createLockedNote({ title: 'bad', body: `bad${String.fromCharCode(0)}body`, parent_id: folder.id });
		const goodNote = await createLockedNote({ title: 'good', body: 'good body', parent_id: folder.id });

		const result = await bulkSetNoteLockState(folder.id, false);

		expect(result).toEqual({ changed: 1, skipped: 0, failed: 1 });
		expect((await Note.load(badNote.id)).is_locked).toBe(1);
		expect((await Note.load(badNote.id)).body).not.toBe(`bad${String.fromCharCode(0)}body`);
		expect((await Note.load(goodNote.id)).body).toBe('good body');

		// A re-run skips the note that succeeded instead of decrypting it a second time.
		const rerun = await bulkSetNoteLockState(folder.id, false);
		expect(rerun).toEqual({ changed: 0, skipped: 1, failed: 1 });
	});

	it('should fail closed when the session is locked', async () => {
		await setUpUnlockedSession();
		const folder = await Folder.save({ title: 'folder' });
		await Note.save({ title: 'one', body: 'secret', parent_id: folder.id });

		NoteLockSession.instance().lock();
		await expect(bulkSetNoteLockState(folder.id, true)).rejects.toThrow();
	});

	it('should throw when note lock is not enabled', async () => {
		await setUpUnlockedSession();
		const folder = await Folder.save({ title: 'folder' });
		Setting.setValue('featureFlag.noteLock', false);
		await expect(bulkSetNoteLockState(folder.id, true)).rejects.toThrow();
	});

});
