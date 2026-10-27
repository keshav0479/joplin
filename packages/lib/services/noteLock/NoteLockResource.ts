import { Dispatch } from 'redux';
import { Mutex } from 'async-mutex';
import { ModelType } from '../../BaseModel';
import Logger from '@joplin/utils/Logger';
import Note from '../../models/Note';
import Resource from '../../models/Resource';
import shim from '../../shim';
import { _n } from '../../locale';
import { NoteEntity, ResourceEntity, ResourceOcrStatus } from '../database/types';
import { isValidHeaderIdentifier } from '../e2ee/EncryptionService';
import NoteLockService from './NoteLockService';
import NoteLockNote from './NoteLockNote';
import NoteLockSession from './NoteLockSession';
import type { DecryptedNoteLockKey } from './NoteLockKey';

const logger = Logger.create('NoteLockResource');

const fileHasNoteLockHeader = async (path: string) => {
	const handle = await shim.fsDriver().open(path, 'r');
	try {
		return isValidHeaderIdentifier(await shim.fsDriver().readFileChunk(handle, 5, 'ascii'), false, true);
	} finally {
		await shim.fsDriver().close(handle);
	}
};

// A locked note's body is encrypted, so its attachment ids come from extracted_resource_ids.
const linkedResourceIds = async (noteId: string) => {
	const note = await Note.load(noteId, { fields: ['id', 'is_locked', 'body', 'extracted_resource_ids'] });
	if (!note) return { note: null as NoteEntity, resourceIds: [] as string[] };
	const resourceIds = NoteLockNote.isLocked(note) ? Note.unserializeExtractedResourceIds(note.extracted_resource_ids) : Note.linkedItemIds(note.body);
	return { note, resourceIds };
};

const downloadedResources = async (resourceIds: string[], isLocked: boolean) => {
	if (!resourceIds.length) return [];
	const resources: ResourceEntity[] = await Resource.modelSelectAll(`
		SELECT id, mime, file_extension FROM resources
		WHERE id IN (${Resource.escapeIdsForSql(resourceIds)}) AND is_locked = ? AND encryption_blob_encrypted = 0
	`, [isLocked ? 1 : 0]);
	const output: ResourceEntity[] = [];
	for (const resource of resources) {
		// A file that is not downloaded yet is handled by a later save of the note.
		if ((await Resource.localState(resource)).fetch_status === Resource.FETCH_STATUS_DONE) output.push(resource);
	}
	return output;
};

// Attachments that another note with the given lock state also uses.
const usedByOtherNotes = async (resourceIds: string[], noteId: string, otherNoteIsLocked: boolean) => {
	if (!resourceIds.length) return [];
	const rows = await Resource.db().selectAll(`
		SELECT DISTINCT nr.resource_id FROM note_resources nr
		INNER JOIN notes n ON n.id = nr.note_id
		WHERE nr.is_associated = 1 AND n.is_locked = ? AND n.deleted_time = 0 AND nr.note_id != ? AND nr.resource_id IN (${Resource.escapeIdsForSql(resourceIds)})
	`, [otherNoteIsLocked ? 1 : 0, noteId]);
	return rows.map(r => r.resource_id as string);
};

// The file is written first and the row after, so an interrupted run leaves an encrypted file
// with is_locked = 0, which the header check picks up on the next run.
const saveLockState = async (resource: ResourceEntity, isLocked: boolean, transform: (srcPath: string, destPath: string)=> Promise<unknown>) => {
	const path = Resource.fullPath(resource);
	if (await fileHasNoteLockHeader(path) !== isLocked) {
		const tempPath = `${path}.tmp`;
		await transform(path, tempPath);
		await shim.fsDriver().move(tempPath, path);
	}

	const now = Date.now();
	await Resource.save({
		id: resource.id,
		is_locked: isLocked ? 1 : 0,
		size: (await shim.fsDriver().stat(path)).size,
		updated_time: now,
		blob_updated_time: now,
		// Recognised text can hold the same data as the file, so it goes with the lock, and the
		// todo status lets OCR run again once the lock is removed.
		...(isLocked ? { ocr_text: '', ocr_details: '', ocr_error: '', ocr_status: ResourceOcrStatus.Todo } : {}),
	}, { autoTimestamp: false });
	// Search only re-indexes attachments that have text, so its copy is removed here.
	if (isLocked) await Resource.db().exec('DELETE FROM items_normalized WHERE item_id = ? AND item_type = ?', [resource.id, ModelType.Resource]);
};

// Brings the attachments of a note in line with its lock state. Locking skips the ones an unlocked
// note also uses. Removing the lock decrypts all of them, even the ones other locked notes use.
// Returns how many could not be changed.
const updateNoteResources = async (noteId: string, key: DecryptedNoteLockKey) => {
	const { note, resourceIds } = await linkedResourceIds(noteId);
	if (!note) return 0;
	const isLocked = NoteLockNote.isLocked(note);

	let resources = await downloadedResources(resourceIds, !isLocked);
	if (isLocked) {
		const sharedIds = await usedByOtherNotes(resources.map(r => r.id), note.id, false);
		resources = resources.filter(r => !sharedIds.includes(r.id));
	}
	if (!resources.length) return 0;

	let failed = 0;
	await NoteLockService.withDecryptedKey(async scoped => {
		for (const resource of resources) {
			try {
				await saveLockState(resource, isLocked, isLocked ? scoped.encryptFile : scoped.decryptFile);
			} catch (error) {
				logger.warn(`Could not ${isLocked ? 'lock' : 'remove the lock from'} attachment ${resource.id}:`, error);
				failed++;
			}
		}
	}, key);
	return failed;
};

export default class NoteLockResource {

	// Set by each app to its store's dispatch, for the banner.
	public static dispatch: Dispatch = (action => action) as Dispatch;

	// One run at a time, so two notes sharing an attachment never write its file together.
	private static mutex_ = new Mutex();
	private static pending_ = 0;

	public static async update(noteId: string, key: DecryptedNoteLockKey = null) {
		key = key ?? NoteLockSession.instance().decryptedKey();
		this.pending_++;
		if (this.pending_ === 1) this.dispatch({ type: 'NOTE_LOCK_RESOURCE_CHANGE_RUNNING_SET', value: true });
		try {
			return await this.mutex_.runExclusive(() => updateNoteResources(noteId, key));
		} finally {
			this.pending_--;
			if (this.pending_ === 0) this.dispatch({ type: 'NOTE_LOCK_RESOURCE_CHANGE_RUNNING_SET', value: false });
		}
	}

	// Resolves once the runs started so far are done, for work that reads the attachment files.
	public static async idle() {
		await this.mutex_.runExclusive(() => {});
	}

	// Runs after the note itself is saved, with the banner showing until it is done. Quitting
	// before then leaves the attachments in the old state until the note is locked or unlocked again.
	public static updateInBackground(noteId: string, key: DecryptedNoteLockKey) {
		void (async () => {
			try {
				const failed = await this.update(noteId, key);
				if (failed) await shim.showErrorDialog(_n('%d attachment could not be updated to match the note lock.', '%d attachments could not be updated to match the note lock.', failed, failed));
			} catch (error) {
				logger.error(`Could not update the attachments of note ${noteId}:`, error);
				await shim.showErrorDialog(error.message);
			}
		})();
	}

	// For the confirmations before a note's lock changes: locking skips attachments an unlocked note
	// uses, and removing the lock also removes it from attachments that other locked notes use.
	public static async sharedResourceCount(noteId: string, isLocking: boolean) {
		const { resourceIds } = await linkedResourceIds(noteId);
		const affectedIds = (await downloadedResources(resourceIds, !isLocking)).map(r => r.id);
		return (await usedByOtherNotes(affectedIds, noteId, !isLocking)).length;
	}
}
