import Logger from '@joplin/utils/Logger';
import { Dispatch } from 'redux';
import { _, _n } from '../../locale';
import type { NoteLockMigrationStatus } from '../../reducer';
import Note from '../../models/Note';
import Revision from '../../models/Revision';
import time from '../../time';
import shim, { MessageBoxType } from '../../shim';
import Setting from '../../models/Setting';
import EncryptionService from '../e2ee/EncryptionService';
import { adoptNoteLockKeyConflict, noteLockKeyConflict } from '../synchronizer/syncInfoUtils';
import isNoteLockEnabled from './isNoteLockEnabled';
import NoteLockKey, { DecryptedNoteLockKey } from './NoteLockKey';
import NoteLockSession from './NoteLockSession';
import NoteLockService from './NoteLockService';

const logger = Logger.create('NoteLockKeyMigration');

export interface NoteLockKeyMigrationResult {
	migrated: number;
	// Locked with a key that is neither the local nor the sync target one, so nothing here can read them.
	skipped: number;
	failed: number;
	// Still encrypted by sync, so their note lock body cannot be read yet. A retry once they are decrypted picks them up.
	awaitingDecryption: number;
	// Note history of locked notes, counted apart from the notes so a failed history version is not mistaken for a failed note.
	failedRevisions: number;
}

// Re-encrypts the notes locked with the local key to the target key; notes already done are left alone, so a retry only
// touches the rest. A re-encryption uses the same key on both sides and only rewrites what an older encryption method left.
const runMigration = async (localKey: DecryptedNoteLockKey, targetKey: DecryptedNoteLockKey, reencrypt: boolean, onStarted: ()=> void) => {
	if (NoteLockSession.instance().isMigrating()) throw new Error(_('This cannot be done while a migration is in progress.'));
	const encryptionService = EncryptionService.instance();
	const isDone = (header: Record<string, string | number>) => {
		return header.masterKeyId === targetKey.id && (!reencrypt || header.encryptionMethod === encryptionService.defaultEncryptionMethod());
	};
	const result: NoteLockKeyMigrationResult = { migrated: 0, skipped: 0, failed: 0, awaitingDecryption: 0, failedRevisions: 0 };
	NoteLockSession.instance().setMigrating(true);
	try {
		onStarted?.();
		for (const noteId of await Note.lockedNoteIds()) {
			try {
				const { body, encryption_applied } = await Note.load(noteId, { fields: ['id', 'body', 'encryption_applied'] });
				if (encryption_applied) {
					result.awaitingDecryption++;
					continue;
				}
				const header = await encryptionService.decodeHeaderString(body, true);
				if (isDone(header)) continue;
				if (header.masterKeyId !== localKey.id) {
					result.skipped++;
					continue;
				}
				const note = await Note.load(noteId, { useNoteLock: true, noteLockKey: localKey });
				// The note keeps its own "updated" date; updated_time still moves so the re-encrypted note syncs.
				await Note.save({ ...note, updated_time: time.unixMs() }, { useNoteLock: true, noteLockKey: targetKey, autoTimestamp: false });
				result.migrated++;
			} catch (error) {
				logger.warn(`Could not migrate note ${noteId}:`, error);
				result.failed++;
			}
			// With the feature turned off the note was not re-encrypted, whether Note.save refused it or saved it ungated.
			if (!isNoteLockEnabled()) throw new Error(_('The migration of your locked notes was cancelled because the note lock feature was turned off.'));
		}
		// A locked revision holds the whole note rather than a diff, so its body is re-encrypted on its own. Revisions under
		// another key cannot be read here, so they are left as they are.
		for (const revisionId of await Revision.lockedRevisionIds()) {
			try {
				const revision = await Revision.load(revisionId);
				// Removed by the revision service since the list was read.
				if (!revision) continue;
				if (revision.encryption_applied) throw new Error('The revision is still encrypted by sync');
				const body = Revision.applyTextPatch('', revision.body_diff);
				const header = await encryptionService.decodeHeaderString(body, true);
				if (isDone(header) || header.masterKeyId !== localKey.id) continue;
				const plainBody = await NoteLockService.withDecryptedKey(scoped => scoped.decryptString(body), localKey);
				const targetBody = await NoteLockService.withDecryptedKey(scoped => scoped.encryptString(plainBody), targetKey);
				// The revision keeps its times, so new history snapshots are still spaced from it, and is uploaded again regardless.
				// Flagged first: sync stays stopped until the migration ends, so a run cut off in between still uploads it.
				await Revision.forceSync(revision.id);
				await Revision.save({ id: revision.id, body_diff: Revision.createTextPatch('', targetBody) }, { autoTimestamp: false });
			} catch (error) {
				logger.warn(`Could not migrate revision ${revisionId}:`, error);
				result.failedRevisions++;
			}
			if (!isNoteLockEnabled()) throw new Error(_('The migration of your locked notes was cancelled because the note lock feature was turned off.'));
		}
	} finally {
		NoteLockSession.instance().setMigrating(false);
	}
	return result;
};

// The local key stays until finish, so an interrupted run loses nothing. onStarted runs once both passwords are accepted.
export const migrateLockedNotes = async (localPassword: string, targetPassword: string, onStarted: ()=> void = null) => {
	if (!isNoteLockEnabled()) throw new Error('Note lock is not enabled');
	const conflict = noteLockKeyConflict();
	if (!conflict) throw new Error('No note lock key conflict to migrate');
	const localKey = await NoteLockKey.instance().decrypt(localPassword);
	const targetKey: DecryptedNoteLockKey = {
		id: conflict.noteLockKey.id,
		plainText: await EncryptionService.instance().decryptMasterKeyContent(conflict.noteLockKey, targetPassword),
	};
	// A sync may have replaced the parked key while the passwords were checked. From here the sync leaves it alone.
	if (noteLockKeyConflict()?.noteLockKey.id !== targetKey.id) throw new Error(_('The note lock key on the sync target changed. Please try again.'));
	return runMigration(localKey, targetKey, false, onStarted);
};

// Moves the locked notes and their history to the current default encryption method, keeping the key.
export const reencryptLockedNotes = async (password: string, onStarted: ()=> void = null) => {
	if (!isNoteLockEnabled()) throw new Error('Note lock is not enabled');
	// The key migration replaces the key these notes would be re-encrypted with.
	if (noteLockKeyConflict()) throw new Error(_('This cannot be done while a migration is in progress.'));
	const key = await NoteLockKey.instance().decrypt(password);
	return runMigration(key, key, true, onStarted);
};

// Locked notes stay closed while a run goes, so after a run with no failures no note is left under the local key, apart
// from an editor save that was already queued when the run started.
export const finishNoteLockKeyMigration = () => {
	adoptNoteLockKeyConflict();
	NoteLockSession.instance().lock();
};

export const confirmAndSkipNoteLockKeyMigration = async (dispatch: Dispatch) => {
	if (await shim.showMessageBox(_('Warning: Notes still locked with the current note lock key will become permanently unreadable. Before continuing, it is recommended to first export all notes on this device as a JEX backup, which can be imported again later if the correct password is used. Are you sure you want to continue without migrating the remaining notes?'), { buttons: [_('Yes'), _('No')], type: MessageBoxType.Confirm, cancelId: 1 }) !== 0) return false;
	finishNoteLockKeyMigration();
	dispatch({ type: 'NOTE_LOCK_MIGRATION_STATUS_SET', value: null });
	return true;
};

// Kept until a re-encryption ends without issues or is skipped, so sync stays blocked across restarts meanwhile.
const reencryptPendingSettingKey = 'noteLock.reencryptPending';

export const confirmAndSkipNoteLockReencrypt = async (dispatch: Dispatch) => {
	if (await shim.showMessageBox(_('Are you sure you want to skip re-encrypting the remaining locked notes?'), { buttons: [_('Yes'), _('No')], type: MessageBoxType.Confirm, cancelId: 1 }) !== 0) return false;
	Setting.setValue(reencryptPendingSettingKey, false);
	dispatch({ type: 'NOTE_LOCK_MIGRATION_STATUS_SET', value: null });
	return true;
};

// Re-encrypted notes would otherwise sync to devices that may not read the newer encryption method yet.
export const checkNoteLockReencryptFinished = () => {
	if (!Setting.value(reencryptPendingSettingKey)) return;
	throw new Error(isNoteLockEnabled()
		? _('Synchronisation is disabled until the re-encryption of your locked notes is finished or skipped.')
		: _('Synchronisation is disabled until the re-encryption of your locked notes is finished. Enable the note lock feature to finish it.'));
};

// Runs in the background once the passwords are accepted, so the app stays usable, and reports its progress for the
// banners. A run with failures keeps the migration open for a retry or a skip.
const startInBackground = async (run: (onStarted: ()=> void)=> Promise<NoteLockKeyMigrationResult>, dispatch: Dispatch, onStarted: ()=> void, bulkChangeRunning: boolean, reencrypt: boolean) => {
	// A note locked by the bulk change after the migration passed it would stay under the old key or method.
	if (bulkChangeRunning) throw new Error(_('Please wait until the current note lock change has finished.'));
	let started = false;
	let result: NoteLockKeyMigrationResult;
	try {
		result = await run(() => {
			started = true;
			if (reencrypt) Setting.setValue(reencryptPendingSettingKey, true);
			onStarted();
			dispatch({ type: 'NOTE_LOCK_MIGRATION_STATUS_SET', value: { running: true, failed: 0, skipped: 0, awaitingDecryption: 0, failedRevisions: 0, reencrypt } });
		});
	} catch (error) {
		// Before the start the dialog is still open to show the error, after it the dialog is gone.
		if (!started) throw error;
		dispatch({ type: 'NOTE_LOCK_MIGRATION_STATUS_SET', value: null });
		await shim.showErrorDialog(error.message);
		return;
	}
	if (!result.failed && !result.awaitingDecryption && !result.failedRevisions) {
		if (reencrypt) {
			Setting.setValue(reencryptPendingSettingKey, false);
		} else {
			finishNoteLockKeyMigration();
		}
	}
	dispatch({ type: 'NOTE_LOCK_MIGRATION_STATUS_SET', value: { running: false, failed: result.failed, skipped: result.skipped, awaitingDecryption: result.awaitingDecryption, failedRevisions: result.failedRevisions, reencrypt } });
};

export const startNoteLockKeyMigration = (localPassword: string, targetPassword: string, dispatch: Dispatch, onStarted: ()=> void, bulkChangeRunning: boolean) => {
	return startInBackground(started => migrateLockedNotes(localPassword, targetPassword, started), dispatch, onStarted, bulkChangeRunning, false);
};

export const startNoteLockReencrypt = (password: string, dispatch: Dispatch, onStarted: ()=> void, bulkChangeRunning: boolean) => {
	return startInBackground(started => reencryptLockedNotes(password, started), dispatch, onStarted, bulkChangeRunning, true);
};

// The notes a run left under the local key, so the banner offers a retry or a skip.
export const notMigratedMessage = (status: NoteLockMigrationStatus) => {
	const parts = [];
	if (status.failed) parts.push(_n('%d locked note could not be migrated.', '%d locked notes could not be migrated.', status.failed, status.failed));
	if (status.failedRevisions) parts.push(_n('%d note history version of a locked note could not be migrated.', '%d note history versions of locked notes could not be migrated.', status.failedRevisions, status.failedRevisions));
	if (status.awaitingDecryption) parts.push(_n('%d locked note is still waiting to be decrypted and was not migrated yet.', '%d locked notes are still waiting to be decrypted and were not migrated yet.', status.awaitingDecryption, status.awaitingDecryption));
	return withSkippedCount(parts.join(' '), status);
};

// Notes already moved to the parked key need it, so a sync must not drop or replace it.
export const parkedNoteLockKeyInUse = async () => {
	const conflict = noteLockKeyConflict();
	if (!conflict) return false;
	for (const noteId of await Note.lockedNoteIds()) {
		const { body, encryption_applied } = await Note.load(noteId, { fields: ['id', 'body', 'encryption_applied'] });
		if (encryption_applied) continue;
		try {
			if ((await EncryptionService.instance().decodeHeaderString(body, true)).masterKeyId === conflict.noteLockKey.id) return true;
		} catch {
			// A body that is not note lock ciphertext cannot use the parked key.
		}
	}
	return false;
};

export const withSkippedCount = (message: string, status: NoteLockMigrationStatus) => {
	if (!status.skipped) return message;
	return `${message} ${_n('%d locked note was skipped because it is locked with another key.', '%d locked notes were skipped because they are locked with another key.', status.skipped, status.skipped)}`;
};
