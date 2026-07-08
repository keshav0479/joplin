import Logger from '@joplin/utils/Logger';
import { RefObject, useCallback, useRef } from 'react';
import { FormNote, NoteBodyEditorRef } from './types';
import { formNoteToNote } from '.';
import ExternalEditWatcher from '@joplin/lib/services/ExternalEditWatcher';
import Note from '@joplin/lib/models/Note';
import type { Dispatch } from 'redux';
import eventManager, { EventName } from '@joplin/lib/eventManager';
import type { OnSetFormNote } from './useFormNote';
import NoteLockSession from '@joplin/lib/services/noteLock/NoteLockSession';

const logger = Logger.create('useScheduleSaveCallbacks');

interface Props {
	setFormNote: RefObject<OnSetFormNote>;
	editorId: string;
	dispatch: Dispatch;
	editorRef: RefObject<NoteBodyEditorRef>;
}

const useScheduleSaveCallbacks = (props: Props) => {
	// Identifies the most recently scheduled save per note, so an older save that completes late
	// cannot clear the dirty state (or blank a locked note) that belongs to a newer pending one.
	const lastScheduledSaveId = useRef<Record<string, number>>({});
	const saveIdCounter = useRef(0);

	const scheduleSaveNote = useCallback((formNote: FormNote) => {
		if (!formNote.saveActionQueue) throw new Error('saveActionQueue is not set!!'); // Sanity check

		// reg.logger().debug('Scheduling...', formNote);

		const saveId = ++saveIdCounter.current;
		lastScheduledSaveId.current[formNote.id] = saveId;

		const makeAction = (formNote: FormNote) => {
			return async function() {
				const useNoteLock = !!formNote.is_locked;

				try {
					// The blank placeholder body would be encrypted over the real content.
					if (useNoteLock && formNote.lockedBodyUnavailable) {
						logger.error('Prevented saving a locked note whose body was never decrypted:', formNote.id);
						return;
					}

					// Note.save rejects lock-state transitions at the model boundary; this early check just
					// avoids that error path when enable/disable changed the state under the editor.
					if (useNoteLock && formNote.id) {
						const current = await Note.load(formNote.id, { fields: ['id', 'is_locked'] });
						if (!current || !current.is_locked) {
							logger.warn('Locked note is gone or no longer locked - keeping the change in the editor:', formNote.id);
							return;
						}
					}

					const note = await formNoteToNote(formNote);
					logger.debug('Saving note...', useNoteLock ? note.id : note);
					const savedNote = await Note.save(note, { changeId: `editorChange-${props.editorId}`, useNoteLock, noteLockKey: useNoteLock ? formNote.noteLockKey : null });

					props.setFormNote.current((prev: FormNote) => {
						if (prev.id !== formNote.id) return prev;
						// A newer save scheduled while this one was in flight owns the dirty state and form content.
						const isLatestSave = lastScheduledSaveId.current[formNote.id] === saveId;
						// New keystrokes since this save was scheduled also keep the note dirty.
						const hasNewerChanges = !isLatestSave || prev.bodyWillChangeId !== 0;
						// Once the plaintext of a locked note is safely persisted and the session is
						// locked, neither it nor the captured key may stay in memory.
						if (useNoteLock && !hasNewerChanges && !NoteLockSession.instance().isUnlocked()) {
							return { ...prev, user_updated_time: savedNote.user_updated_time, hasChanged: false, body: '', noteLockKey: null, lockedBodyUnavailable: true };
						}
						return { ...prev, user_updated_time: savedNote.user_updated_time, hasChanged: hasNewerChanges ? prev.hasChanged : false };
					});

					// savedNote.body is ciphertext for a locked note; keep it out of the watched file.
					if (!useNoteLock) void ExternalEditWatcher.instance().updateNoteFile(savedNote);

					eventManager.emit(EventName.NoteContentChange, { note: savedNote });
				} catch (error) {
					// A throw would leave the queue's completion promise hanging, blocking app close.
					// The form note keeps hasChanged, so the content stays in the editor.
					logger.error('Could not save note:', formNote.id, error);
				} finally {
					props.dispatch({
						type: 'EDITOR_NOTE_STATUS_REMOVE',
						id: formNote.id,
					});
				}
			};
		};

		formNote.saveActionQueue.push(makeAction(formNote));
		return formNote.saveActionQueue.waitForAllDone();
	}, [props.dispatch, props.editorId, props.setFormNote]);

	const saveNoteIfWillChange = useCallback(async (formNote: FormNote) => {
		if (!formNote.id || !formNote.bodyWillChangeId || !props.editorRef.current) return;

		const body = await props.editorRef.current.content();

		void scheduleSaveNote({
			...formNote,
			body: body,
			bodyWillChangeId: 0,
			bodyChangeId: 0,
		});
	}, [scheduleSaveNote, props.editorRef]);

	return { saveNoteIfWillChange, scheduleSaveNote };
};

export default useScheduleSaveCallbacks;
