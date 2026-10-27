import { Dispatch } from 'redux';
import { _, _n } from '../../locale';
import shim, { MessageBoxType } from '../../shim';
import { ModelType } from '../../BaseModel';
import BaseItem from '../../models/BaseItem';
import ItemChange from '../../models/ItemChange';
import Folder from '../../models/Folder';
import Note from '../../models/Note';
import Setting from '../../models/Setting';
import { itemIsReadOnlySync, ItemSlice } from '../../models/utils/readOnly';
import eventManager, { EventName } from '../../eventManager';
import { noteLockKeyConflict } from '../synchronizer/syncInfoUtils';
import isNoteLockEnabled from './isNoteLockEnabled';
import NoteLockSession from './NoteLockSession';
import { NoteLockNoteEntity } from './NoteLockNote';
import { NoteLockPrompts, unlockNoteLockSession } from './noteLockPrompts';
import NoteLockResource from './NoteLockResource';

export const folderTreeNoteIds = async (folderId: string) => {
	const folderIds = [folderId].concat((await Folder.allChildrenFolders(folderId)).map(folder => folder.id));
	let noteIds: string[] = [];
	for (const id of folderIds) noteIds = noteIds.concat(await Folder.noteIds(id));
	return noteIds;
};

// A migration re-encrypts the notes locked with the local key, so a note locked with it once the migration is needed would be left behind.
const throwIfMigrationNeeded = () => {
	if (noteLockKeyConflict()) throw new Error(_('The note lock cannot be changed while your locked notes need to be migrated to the synced key.'));
};

// Unlike the single-note flow in setNoteLockState, this saves the notes itself, since most of them are not
// open in an editor. The event still goes out so that an editor which has one of them open picks up the new state.
const bulkSetNoteLockState = async (noteIds: string[], isLocked: boolean) => {
	if (!isNoteLockEnabled()) throw new Error('Note lock is not enabled');
	// Captured once so that locking the session mid-run does not fail the remaining notes. Throws if the session is locked.
	const noteLockKey = NoteLockSession.instance().decryptedKey();

	const result = { changed: 0, skipped: 0, failed: 0, failedResources: 0 };
	for (const noteId of noteIds) {
		throwIfMigrationNeeded();
		try {
			// Checked before the body is decrypted, so a note locked with another key is skipped rather than failed.
			if (isLocked && (await Note.load(noteId, { fields: ['id', 'is_locked'] }))?.is_locked) {
				result.skipped++;
				continue;
			}
			const note: NoteLockNoteEntity = await Note.load(noteId, { useNoteLock: true, noteLockKey });
			if (!note || !!note.is_locked === isLocked || note.deleted_time || note.is_conflict || note.encryption_applied || itemIsReadOnlySync(ModelType.Note, ItemChange.SOURCE_UNSPECIFIED, note as ItemSlice, Setting.value('sync.userId'), BaseItem.syncShareCache)) {
				result.skipped++;
				continue;
			}
			// Without the marker the load was not gated, as when the feature is turned off during it, so the body
			// would be saved back under the wrong lock state.
			if (!note.isDecrypted) throw new Error('The note was loaded without the note lock gate');
			// Validated like a save from the note screen, so a body that cannot be stored is reported rather than written.
			await Note.save({ ...note, is_locked: isLocked ? 1 : 0 }, { useNoteLock: true, noteLockKey, userSideValidation: true, skipNoteLockResources: true });
			eventManager.emit(EventName.NoteLockNoteStateChange, { noteId, isLocked });
			result.changed++;
			result.failedResources += await NoteLockResource.update(noteId, noteLockKey);
		} catch {
			result.failed++;
		}
		// With the feature turned off, Note.save refuses the change, so the remaining notes would all fail too.
		if (!isNoteLockEnabled()) throw new Error(_('Note lock changes were cancelled because the note lock feature was disabled.'));
	}
	return result;
};

let running = false;

interface BulkNoteLockOptions {
	// A whole notebook can mix locked and unlocked notes, which a change by accident would lose, so it is confirmed first.
	wholeNotebook?: boolean;
	// Runs once the session is unlocked, for the work that must happen just before the notes change.
	beforeChange?: ()=> Promise<void>;
}

export const promptAndBulkSetNoteLockState = async (noteIds: string[], isLocked: boolean, prompts: NoteLockPrompts, dispatch: Dispatch, options: BulkNoteLockOptions = {}) => {
	if (running) {
		await shim.showErrorDialog(_('Please wait until the current note lock change has finished.'));
		return;
	}
	running = true;
	let message = '';
	try {
		throwIfMigrationNeeded();
		if (options.wholeNotebook) {
			const question = isLocked
				? _('Are you sure you want to lock all notes in this notebook and its nested notebooks? Their attachments will be locked too, except the ones that notes which are not locked also use.')
				: _('Are you sure you want to remove lock from all notes in this notebook and its nested notebooks? This also removes the lock from their attachments, including the ones that other locked notes use.');
			if (await shim.showMessageBox(question, { buttons: [_('Yes'), _('No')], type: MessageBoxType.Confirm, cancelId: 1 }) !== 0) return;
		}
		if (!await unlockNoteLockSession(prompts)) return;
		await options.beforeChange?.();
		dispatch({ type: 'NOTE_LOCK_BULK_CHANGE_RUNNING_SET', value: true });
		const { failed, failedResources } = await bulkSetNoteLockState(noteIds, isLocked);
		const messages = [];
		if (failed) {
			messages.push(isLocked
				? _n('%d note could not be locked.', '%d notes could not be locked.', failed, failed)
				: _n('The note lock could not be removed from %d note.', 'The note lock could not be removed from %d notes.', failed, failed));
		}
		if (failedResources) messages.push(_n('%d attachment could not be updated to match the note lock.', '%d attachments could not be updated to match the note lock.', failedResources, failedResources));
		message = messages.join('\n');
	} catch (error) {
		message = error.message;
	} finally {
		running = false;
		dispatch({ type: 'NOTE_LOCK_BULK_CHANGE_RUNNING_SET', value: false });
	}
	if (message) await shim.showErrorDialog(message);
};

export default bulkSetNoteLockState;
