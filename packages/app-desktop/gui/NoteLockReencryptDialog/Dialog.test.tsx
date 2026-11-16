import * as React from 'react';
import * as ReactDom from 'react-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { createStore } from 'redux';
import shim from '@joplin/lib/shim';
import NoteLockReencryptDialog from './Dialog';
import { startNoteLockReencrypt } from '@joplin/lib/services/noteLock/NoteLockKeyMigration';

jest.mock('@joplin/lib/services/noteLock/NoteLockKeyMigration', () => ({
	startNoteLockReencrypt: jest.fn(),
}));

// Same jsdom setup as the migration dialog test.
shim.setReactDom(ReactDom);
(globalThis as unknown as { React: typeof React }).React = React;
HTMLDialogElement.prototype.showModal = function() { this.open = true; };
HTMLDialogElement.prototype.close = function() { this.open = false; };

const startMock = startNoteLockReencrypt as jest.Mock;

const renderDialog = () => {
	const dispatch = jest.fn();
	const store = createStore(() => ({ noteLockBulkChangeRunning: false }));
	render(<Provider store={store}><NoteLockReencryptDialog themeId={1} dispatch={dispatch}/></Provider>);
	fireEvent.change(screen.getByLabelText('Note lock password'), { target: { value: 'password' } });
	return dispatch;
};

describe('NoteLockReencryptDialog/Dialog', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	test('should start only once the re-encryption is confirmed, then close', async () => {
		const showMessageBox = jest.spyOn(shim, 'showMessageBox').mockResolvedValueOnce(1).mockResolvedValueOnce(0);
		startMock.mockImplementation(async (_password: string, _dispatch: unknown, onStarted: ()=> void) => onStarted());
		const dispatch = renderDialog();

		fireEvent.click(screen.getByText('Re-encrypt notes'));
		await waitFor(() => expect(showMessageBox).toHaveBeenCalledTimes(1));
		expect(startMock).not.toHaveBeenCalled();

		fireEvent.click(screen.getByText('Re-encrypt notes'));
		await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'DIALOG_CLOSE', name: 'noteLockReencrypt' }));
		expect(showMessageBox.mock.calls[0][0]).toBe('Are you sure you want to re-encrypt your locked notes?');
		expect(startMock).toHaveBeenCalledWith('password', dispatch, expect.any(Function), false);
		showMessageBox.mockRestore();
	});

	test('should report a wrong password and stay open', async () => {
		const showMessageBox = jest.spyOn(shim, 'showMessageBox').mockResolvedValue(0);
		startMock.mockRejectedValue(Object.assign(new Error('bad'), { name: 'OperationError' }));
		const dispatch = renderDialog();

		fireEvent.click(screen.getByText('Re-encrypt notes'));

		expect((await screen.findByRole('alert')).textContent).toContain('Invalid password');
		expect(dispatch).not.toHaveBeenCalled();
		showMessageBox.mockRestore();
	});
});
