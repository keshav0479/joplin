import * as React from 'react';
import { useCallback } from 'react';
import { Dispatch } from 'redux';
import { _ } from '@joplin/lib/locale';
import Button, { ButtonLevel } from '../../Button/Button';

interface Props {
	noteTitle: string;
	hasNoteLockKey: boolean;
	dispatch: Dispatch;
}

export default function NoteLockPanel(props: Props) {
	const onUnlockClick = useCallback(() => {
		props.dispatch({
			type: 'DIALOG_OPEN',
			name: 'noteLockUnlock',
		});
	}, [props.dispatch]);

	const onSetUpClick = useCallback(() => {
		props.dispatch({
			type: 'NAV_GO',
			routeName: 'Config',
			props: { defaultSection: 'noteLock' },
		});
	}, [props.dispatch]);

	const renderAction = () => {
		if (!props.hasNoteLockKey) {
			return (
				<>
					<p className="message">{_('Reading this note requires the note lock password, which has not been set up on this device yet.')}</p>
					<Button level={ButtonLevel.Primary} title={_('Set up note lock')} onClick={onSetUpClick} />
				</>
			);
		}

		return (
			<>
				<p className="message">{_('This note is encrypted. Enter the note lock password to unlock encrypted notes for this session.')}</p>
				<Button level={ButtonLevel.Primary} title={_('Unlock')} onClick={onUnlockClick} />
			</>
		);
	};

	return (
		<div className="note-lock-panel">
			<i className="icon fas fa-lock" role="img" aria-label={_('Locked note')}></i>
			<h2 className="title">{props.noteTitle}</h2>
			{renderAction()}
		</div>
	);
}
