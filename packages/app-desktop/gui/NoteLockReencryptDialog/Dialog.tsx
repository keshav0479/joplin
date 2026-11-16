import * as React from 'react';
import { Dispatch } from 'redux';
import { useCallback, useState } from 'react';
import { useSelector } from 'react-redux';
import { AppState } from '../../app.reducer';
import { _ } from '@joplin/lib/locale';
import shim, { MessageBoxType } from '@joplin/lib/shim';
import DialogButtonRow, { ClickEvent } from '../DialogButtonRow';
import Dialog from '@joplin/lib/components/Dialog';
import DialogTitle from '../DialogTitle';
import LabelledPasswordInput from '../PasswordInput/LabelledPasswordInput';
import { startNoteLockReencrypt } from '@joplin/lib/services/noteLock/NoteLockKeyMigration';

interface Props {
	themeId: number;
	dispatch: Dispatch;
}

export default function(props: Props) {
	const [password, setPassword] = useState('');
	const [reencrypting, setReencrypting] = useState(false);
	const [errorMessage, setErrorMessage] = useState('');
	const bulkChangeRunning = useSelector((state: AppState) => state.noteLockBulkChangeRunning);

	const onClose = useCallback(() => {
		props.dispatch({
			type: 'DIALOG_CLOSE',
			name: 'noteLockReencrypt',
		});
	}, [props.dispatch]);

	const onPasswordChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
		setPassword(event.target.value);
	}, []);

	const onButtonRowClick = useCallback(async (event: ClickEvent) => {
		if (event.buttonName === 'cancel') {
			onClose();
			return;
		}

		if (event.buttonName === 'ok') {
			if (await shim.showMessageBox(_('Are you sure you want to re-encrypt your locked notes?'), { buttons: [_('Yes'), _('No')], type: MessageBoxType.Confirm, cancelId: 1 }) !== 0) return;
			setReencrypting(true);
			setErrorMessage('');
			try {
				await startNoteLockReencrypt(password, props.dispatch, onClose, bulkChangeRunning);
			} catch (error) {
				setErrorMessage(error.name === 'OperationError' ? _('Invalid password') : error.message);
				setReencrypting(false);
			}
		}
	}, [password, onClose, props.dispatch, bulkChangeRunning]);

	return (
		<Dialog onCancel={reencrypting ? undefined : onClose} className="note-lock-migration-dialog">
			<div className="dialog-root">
				<DialogTitle title={_('Re-encrypt locked notes')}/>
				<div className="dialog-content">
					<p>{_('A migration will be performed which may take some time if you have a large number of locked notes. However, only notes that aren\'t already using the latest available encryption method will be re-encrypted. During this process, locked notes will be inaccessible and synchronisation will be disabled. Before proceeding, we recommend creating a JEX backup of all your data, as the new encryption method may make locked notes incompatible with older versions of Joplin.')}</p>
					<div className="form">
						<LabelledPasswordInput
							labelText={_('Note lock password')}
							value={password}
							onChange={onPasswordChange}
						/>
					</div>
					{!!errorMessage && <p className="error-message" role="alert">{errorMessage}</p>}
				</div>
				<DialogButtonRow
					themeId={props.themeId}
					onClick={onButtonRowClick}
					okButtonLabel={_('Re-encrypt notes')}
					okButtonDisabled={!password || reencrypting}
					cancelButtonDisabled={reencrypting}
				/>
			</div>
		</Dialog>
	);
}
