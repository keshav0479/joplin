import { CommandRuntime, CommandDeclaration, CommandContext } from '@joplin/lib/services/CommandService';
import { _ } from '@joplin/lib/locale';
import Resource from '@joplin/lib/models/Resource';
import isNoteLockEnabled from '@joplin/lib/services/noteLock/isNoteLockEnabled';
import NoteLockSession from '@joplin/lib/services/noteLock/NoteLockSession';
import NoteLockResourceCache from '@joplin/lib/services/noteLock/NoteLockResourceCache';

export const declaration: CommandDeclaration = {
	name: 'openPdfViewer',
	label: () => _('Open PDF viewer'),
};

export const runtime = (): CommandRuntime => {
	return {
		execute: async (context: CommandContext, resourceId: string, pageNo: number) => {

			const resource = await Resource.load(resourceId);
			if (!resource) throw new Error(`No such resource: ${resourceId}`);
			if (resource.mime !== 'application/pdf') throw new Error(`Not a PDF: ${resource.mime}`);
			// A locked PDF is shown from its decrypted copy, which needs the session unlocked.
			let filePath = Resource.fullPath(resource);
			if (isNoteLockEnabled() && resource.is_locked) {
				if (!NoteLockSession.instance().isUnlocked()) {
					context.dispatch({ type: 'DIALOG_OPEN', name: 'noteLockUnlock', props: { successCommand: { name: 'openPdfViewer', args: [resourceId, pageNo] } } });
					return;
				}
				filePath = await NoteLockResourceCache.load(resource);
			}
			context.dispatch({
				type: 'DIALOG_OPEN',
				name: 'pdfViewer',
				props: {
					resource,
					filePath,
					pageNo: pageNo,
				},
			});
		},
	};
};
