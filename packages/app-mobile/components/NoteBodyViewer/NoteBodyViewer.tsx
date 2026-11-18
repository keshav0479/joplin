import * as React from 'react';

import useOnMessage, { HandleMessageCallback, OnMarkForDownloadCallback } from './hooks/useOnMessage';
import { useRef, useCallback, useContext } from 'react';
import { View, ViewStyle } from 'react-native';
import ExtendedWebView from '../ExtendedWebView';
import { WebViewControl } from '../ExtendedWebView/types';
import useOnResourceLongPress from './hooks/useOnResourceLongPress';
import useRerenderHandler, { ResourceInfo } from './hooks/useRerenderHandler';
import useSource from './hooks/useSource';
import { PluginStates } from '@joplin/lib/services/plugins/reducer';
import { MarkupLanguage } from '@joplin/renderer';
import shim from '@joplin/lib/shim';
import CommandService from '@joplin/lib/services/CommandService';
import Resource from '@joplin/lib/models/Resource';
import NavService from '@joplin/lib/services/NavService';
import isNoteLockEnabled from '@joplin/lib/services/noteLock/isNoteLockEnabled';
import NoteLockSession from '@joplin/lib/services/noteLock/NoteLockSession';
import { unlockNoteLockSession } from '@joplin/lib/services/noteLock/noteLockPrompts';
import { parseResourceUrl } from '@joplin/lib/urlUtils';
import { DialogContext } from '../DialogManager';
import { AppState } from '../../utils/types';
import { connect } from 'react-redux';
import useWebViewSetup from '../../contentScripts/rendererBundle/useWebViewSetup';
import { OnScrollCallback } from '../../contentScripts/rendererBundle/types';
import Logger from '@joplin/utils/Logger';

const perfLogger = Logger.create('NoteBodyViewer-perf');

interface Props {
	themeId: number;
	style: ViewStyle;
	fontSize: number;
	noteBody: string;
	noteMarkupLanguage: MarkupLanguage;
	highlightedKeywords: string[];
	noteResources: Record<string, ResourceInfo>;
	paddingBottom: number;
	initialScrollPercent: number|null;
	noteHash: string;
	onCheckboxChange?: HandleMessageCallback;
	onRequestEditResource?: HandleMessageCallback;
	onMarkForDownload?: OnMarkForDownloadCallback;
	onScroll: OnScrollCallback;
	onLoadEnd?: ()=> void;
	pluginStates: PluginStates;
	showNoteLinkIcon: boolean;
}

function NoteBodyViewer(props: Props) {
	const webviewRef = useRef<WebViewControl>(null);
	const dialogs = useContext(DialogContext);

	const onJoplinLinkClick = useCallback(async (message: string) => {
		try {
			// Tapping a locked attachment while the session is locked asks for the password first. An image then shows in
			// the note, so only other files are opened.
			const resourceId = parseResourceUrl(message)?.itemId;
			const resource = isNoteLockEnabled() && resourceId && !NoteLockSession.instance().isUnlocked() ? await Resource.load(resourceId, { fields: ['is_locked', 'mime'] }) : null;
			if (resource?.is_locked) {
				const unlocked = await unlockNoteLockSession({
					promptPassword: label => dialogs.promptForText(label, '', true),
					goToNoteLockSetup: () => void NavService.go('Config', { sectionName: 'noteLock' }),
				});
				if (!unlocked || Resource.isSupportedImageMimeType(resource.mime)) return;
			}
			await CommandService.instance().execute('openItem', message);
		} catch (error) {
			await shim.showErrorDialog(error.message);
		}
	}, [dialogs]);

	const onScroll = props.onScroll;

	const onResourceLongPress = useOnResourceLongPress(
		{
			onJoplinLinkClick,
			onRequestEditResource: props.onRequestEditResource,
		},
	);

	const onPostMessage = useOnMessage(props.noteBody, {
		onMarkForDownload: props.onMarkForDownload,
		onJoplinLinkClick,
		onRequestEditResource: props.onRequestEditResource,
		onCheckboxChange: props.onCheckboxChange,
		onResourceLongPress,
	});

	const { api: renderer, pageSetup, webViewEventHandlers, hasPluginScripts } = useWebViewSetup({
		webviewRef,
		onBodyScroll: onScroll,
		onPostMessage,
		pluginStates: props.pluginStates,
		themeId: props.themeId,
	});

	useRerenderHandler({
		renderer,
		fontSize: props.fontSize,
		noteBody: props.noteBody,
		noteMarkupLanguage: props.noteMarkupLanguage,
		themeId: props.themeId,
		highlightedKeywords: props.highlightedKeywords,
		noteResources: props.noteResources,
		noteHash: props.noteHash,
		initialScrollPercent: props.initialScrollPercent,

		paddingBottom: props.paddingBottom,
		showNoteLinkIcon: props.showNoteLinkIcon,
	});

	const loadStartRef = useRef(Date.now());
	const onLoadStart = useCallback(() => {
		loadStartRef.current = Date.now();
	}, []);
	const onLoadEnd = useCallback(() => {
		perfLogger.info(`[perf] WebView onLoadEnd fired ${Date.now() - loadStartRef.current} ms after load start`);
		webViewEventHandlers.onLoadEnd();
		if (props.onLoadEnd) props.onLoadEnd();
	}, [props.onLoadEnd, webViewEventHandlers]);

	const { html, js } = useSource(pageSetup, props.themeId);

	return (
		<View style={props.style}>
			<ExtendedWebView
				ref={webviewRef}
				webviewInstanceId='NoteBodyViewer'
				testID='NoteBodyViewer'
				html={html}
				allowFileAccessFromJs={true}
				injectedJavaScript={js}
				mixedContentMode="always"
				onLoadStart={onLoadStart}
				onLoadEnd={onLoadEnd}
				onMessage={webViewEventHandlers.onMessage}
				hasPluginScripts={hasPluginScripts}
			/>
		</View>
	);
}

export default connect((state: AppState) => ({
	themeId: state.settings.theme,
	fontSize: state.settings['style.viewer.fontSize'],
	pluginStates: state.pluginService.plugins,
	showNoteLinkIcon: state.settings['notes.showNoteLinkIcon'],
}))(NoteBodyViewer);
