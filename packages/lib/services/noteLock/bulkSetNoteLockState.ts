import { ModelType } from '../../BaseModel';
import BaseItem from '../../models/BaseItem';
import ItemChange from '../../models/ItemChange';
import Folder from '../../models/Folder';
import Note from '../../models/Note';
import Setting from '../../models/Setting';
import { itemIsReadOnlySync, ItemSlice } from '../../models/utils/readOnly';
import isNoteLockEnabled from './isNoteLockEnabled';
import NoteLockNote from './NoteLockNote';
import NoteLockSession from './NoteLockSession';

// Unlike the single-note flow in setNoteLockState, this persists directly: the notes are
// not open in a note screen that could pick up an emitted event and save them.
const bulkSetNoteLockState = async (folderId: string, isLocked: boolean) => {
	if (!isNoteLockEnabled()) throw new Error('Note lock is not enabled');
	// Captured once so that locking the session mid-run does not fail the remaining notes.
	const key = NoteLockSession.instance().decryptedKey();

	const result = { changed: 0, skipped: 0, failed: 0 };
	const folderIds = [folderId].concat(await Folder.childrenIds(folderId));
	for (const id of folderIds) {
		for (const noteId of await Folder.noteIds(id)) {
			try {
				let note = await Note.load(noteId);
				if (!note || !!note.is_locked === isLocked || itemIsReadOnlySync(ModelType.Note, ItemChange.SOURCE_UNSPECIFIED, note as ItemSlice, Setting.value('sync.userId'), BaseItem.syncShareCache)) {
					result.skipped++;
					continue;
				}
				if (!isLocked) note = await NoteLockNote.decryptBody(note, key);
				// Same save shape as the note screen's lock state change handler.
				const toSave = { ...note, is_locked: isLocked ? 1 : 0, isDecrypted: isLocked };
				await Note.save(toSave, { useNoteLock: true, noteLockKey: key, userSideValidation: true });
				result.changed++;
			} catch {
				result.failed++;
			}
		}
	}
	return result;
};

export default bulkSetNoteLockState;
