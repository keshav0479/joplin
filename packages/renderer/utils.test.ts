import defaultResourceModel from './defaultResourceModel';
import { imageReplacement } from './utils';
import { describe, test, expect } from '@jest/globals';

describe('utils', () => {

	test('should show a locked image as decrypting, as locked with a tap to unlock, or from its decrypted copy', () => {
		const resourceId = 'f6afba55bdf74568ac94f8d1e3578d2c';
		const ResourceModel = {
			...defaultResourceModel,
			isResourceUrl: (url: string) => url.startsWith(':/'),
			urlToId: (url: string) => url.substring(2),
			filename: (resource: { id?: string }) => `${resource.id}.png`,
			isSupportedImageMimeType: (type: string) => type === 'image/png',
		};
		const render = (noteLock: { path?: string; sessionLocked?: boolean; mismatch?: boolean }) => imageReplacement(ResourceModel, { src: `:/${resourceId}`, alt: '', title: '' }, {
			[resourceId]: {
				item: { id: resourceId, is_locked: 1, mime: 'image/png', updated_time: 1 },
				localState: { fetch_status: 2 },
				noteLock,
			},
		}, './', null, 'postMessage');

		expect(render({})).toContain('resource-status-decrypting');
		const locked = render({ sessionLocked: true }) as string;
		expect(locked).toContain('resource-status-locked');
		expect(locked).toContain(`onclick="postMessage(&quot;joplin://${resourceId}&quot;, { resourceId: &quot;${resourceId}&quot; }); return false;"`);
		expect(render({ path: `locked-cache/${resourceId}.png`, mismatch: true })).toEqual({
			'data-resource-id': resourceId,
			src: `./locked-cache/${resourceId}.png?t=1`,
			class: 'note-lock-mismatch',
		});
	});
});
