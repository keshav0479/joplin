import Note from '@joplin/lib/models/Note';
import Setting from '@joplin/lib/models/Setting';
import { setupDatabaseAndSynchronizer, supportDir, switchClient } from '@joplin/lib/testing/test-utils';
import { act, renderHook, waitFor } from '@testing-library/react';
import useFormNote, { HookDependencies } from './useFormNote';
import shim from '@joplin/lib/shim';
import Resource from '@joplin/lib/models/Resource';
import { join } from 'path';
import { formNoteToNote } from '.';
import NoteLockNote from '@joplin/lib/services/noteLock/NoteLockNote';
import NoteLockSession from '@joplin/lib/services/noteLock/NoteLockSession';

const defaultFormNoteProps: HookDependencies = {
	noteId: '',
	isProvisional: false,
	titleInputRef: null,
	editorRef: null,
	onBeforeLoad: () => { },
	onAfterLoad: () => { },
	editorId: 'editor',
	builtInEditorVisible: false,
	noteLockSessionUnlocked: false,
};

describe('useFormNote', () => {
	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
	});

	// The session and decryption internals are covered by the lib tests; here they are mocked to
	// test only the hook's gating: ciphertext must never reach the form note.
	it('should never expose a locked note body: blank it while the session is locked, decrypt it while unlocked', async () => {
		Setting.setValue('featureFlag.noteLock', true);
		// A direct save of a new note with is_locked keeps the raw body, standing in for ciphertext.
		const testNote = await Note.save({ title: 'Locked note', body: 'ciphertext', is_locked: 1 });

		const isUnlockedMock = jest.spyOn(NoteLockSession.instance(), 'isUnlocked').mockReturnValue(false);
		const decryptedKeyMock = jest.spyOn(NoteLockSession.instance(), 'decryptedKey').mockReturnValue({ id: 'key-id', plainText: 'key' });
		const decryptBodyMock = jest.spyOn(NoteLockNote, 'decryptBody').mockImplementation(async note => ({ ...note, body: 'secret content' }));

		try {
			const lockedRender = renderHook(props => useFormNote(props), {
				initialProps: { ...defaultFormNoteProps, noteId: testNote.id },
			});
			await waitFor(() => {
				expect(lockedRender.result.current.formNote.id).toBe(testNote.id);
			});
			expect(lockedRender.result.current.formNote).toMatchObject({
				is_locked: 1,
				lockedBodyUnavailable: true,
				body: '',
			});
			lockedRender.unmount();

			isUnlockedMock.mockReturnValue(true);
			const unlockedRender = renderHook(props => useFormNote(props), {
				initialProps: { ...defaultFormNoteProps, noteId: testNote.id, noteLockSessionUnlocked: true },
			});
			await waitFor(() => {
				expect(unlockedRender.result.current.formNote.id).toBe(testNote.id);
			});
			expect(unlockedRender.result.current.formNote).toMatchObject({
				is_locked: 1,
				lockedBodyUnavailable: false,
				body: 'secret content',
				noteLockKey: { id: 'key-id', plainText: 'key' },
			});
			unlockedRender.unmount();

			// A decryption failure while unlocked must also keep the body out of the form note.
			decryptBodyMock.mockRejectedValue(new Error('key mismatch'));
			const failedRender = renderHook(props => useFormNote(props), {
				initialProps: { ...defaultFormNoteProps, noteId: testNote.id, noteLockSessionUnlocked: true },
			});
			await waitFor(() => {
				expect(failedRender.result.current.formNote.id).toBe(testNote.id);
			});
			expect(failedRender.result.current.formNote).toMatchObject({
				lockedBodyUnavailable: true,
				body: '',
			});
			failedRender.unmount();

			// Safe handling is not feature-flag gated: a synced locked note stays blanked with the flag off.
			Setting.setValue('featureFlag.noteLock', false);
			isUnlockedMock.mockReturnValue(false);
			const flagOffRender = renderHook(props => useFormNote(props), {
				initialProps: { ...defaultFormNoteProps, noteId: testNote.id },
			});
			await waitFor(() => {
				expect(flagOffRender.result.current.formNote.id).toBe(testNote.id);
			});
			expect(flagOffRender.result.current.formNote).toMatchObject({
				lockedBodyUnavailable: true,
				body: '',
			});
			flagOffRender.unmount();
		} finally {
			isUnlockedMock.mockRestore();
			decryptedKeyMock.mockRestore();
			decryptBodyMock.mockRestore();
			Setting.setValue('featureFlag.noteLock', false);
		}
	});

	it('should update note when decryption completes', async () => {
		const testNote = await Note.save({ title: 'Test Note!' });

		const makeFormNoteProps = (): HookDependencies => {
			return {
				...defaultFormNoteProps,
				noteId: testNote.id,
			};
		};

		const formNote = renderHook(props => useFormNote(props), {
			initialProps: makeFormNoteProps(),
		});
		await waitFor(() => {
			// id is falsy until after the first load of the form note.
			expect(formNote.result.current.formNote.id).not.toBeFalsy();
		});
		expect(formNote.result.current.formNote).toMatchObject({
			encryption_applied: 0,
			title: testNote.title,
		});

		await act(async () => {
			await Note.save({
				id: testNote.id,
				encryption_cipher_text: 'cipher_text',
				encryption_applied: 1,
			});
		});

		// Changing encryption_applied should cause a re-render
		await waitFor(() => {
			expect(formNote.result.current.formNote).toMatchObject({
				encryption_applied: 1,
			});
		});

		await act(async () => {
			await Note.save({
				id: testNote.id,
				encryption_applied: 0,
				title: 'Test Note!',
			});
		});

		// Ending decryption should also cause a re-render
		await waitFor(() => {
			expect(formNote.result.current.formNote).toMatchObject({
				encryption_applied: 0,
			});
			// A larger-than-default timeout is needed to prevent CI failures:
		}, { timeout: 15_000 });

		formNote.unmount();
	});


	// Lacking is_conflict has previously caused UI issues. See https://github.com/laurent22/joplin/pull/10913
	// for details.
	it('should preserve value of is_conflict on save', async () => {
		const testNote = await Note.save({ title: 'Test Note!', is_conflict: 1 });

		const makeFormNoteProps = (): HookDependencies => {
			return {
				...defaultFormNoteProps,
				noteId: testNote.id,
			};
		};

		const formNote = renderHook(props => useFormNote(props), {
			initialProps: makeFormNoteProps(),
		});
		await waitFor(() => {
			expect(formNote.result.current.formNote).toMatchObject({
				is_conflict: 1,
				title: testNote.title,
			});
		});

		// Should preserve is_conflict after save.
		expect(await formNoteToNote(formNote.result.current.formNote)).toMatchObject({
			is_conflict: 1,
			deleted_time: 0,
			title: testNote.title,
		});

		formNote.unmount();
	});

	it('should reload the note when it is changed outside of the editor', async () => {
		const note = await Note.save({ title: 'Test Note!', body: '...' });

		const props = {
			...defaultFormNoteProps,
			noteId: note.id,
		};

		const formNote = renderHook(props => useFormNote(props), {
			initialProps: props,
		});

		await waitFor(() => {
			expect(formNote.result.current.formNote.title).toBe('Test Note!');
		});

		// Simulate the note being modified outside the editor
		await act(async () => {
			await Note.save({ id: note.id, title: 'Modified' });
		});

		await waitFor(() => {
			expect(formNote.result.current.formNote.title).toBe('Modified');
		});

		formNote.unmount();
	});

	test('should refresh resource infos when changed outside the editor', async () => {
		let note = await Note.save({});
		note = await shim.attachFileToNote(note, join(supportDir, 'sample.txt'));
		const resourceIds = Note.linkedItemIds(note.body);
		const resource = await Resource.load(resourceIds[0]);

		const makeFormNoteProps = (): HookDependencies => {
			return {
				...defaultFormNoteProps,
				noteId: note.id,
			};
		};

		const formNote = renderHook(props => useFormNote(props), {
			initialProps: makeFormNoteProps(),
		});

		await waitFor(() => {
			expect(Object.values(formNote.result.current.resourceInfos).length).toBeGreaterThan(0);
		});
		const initialResourceInfos = formNote.result.current.resourceInfos;
		expect(initialResourceInfos).toMatchObject({
			[resource.id]: { item: { id: resource.id } },
		});

		await act(async () => {
			await Resource.save({ ...resource, filename: 'test.txt' });
		});
		await waitFor(() => {
			const resourceInfo = formNote.result.current.resourceInfos[resource.id];
			expect(resourceInfo.item).toMatchObject({
				id: resource.id, filename: 'test.txt',
			});
		});

		formNote.unmount();
	});
});
