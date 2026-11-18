import defaultResourceModel from '../defaultResourceModel';
import linkReplacement from './linkReplacement';
import { describe, test, expect } from '@jest/globals';

describe('linkReplacement', () => {

	test('should handle non-resource links', () => {
		const r = linkReplacement('https://example.com/test').html;
		expect(r).toBe('<a data-from-md href=\'https://example.com/test\' onclick=\'postMessage(&quot;https://example.com/test&quot;, { resourceId: &quot;&quot; }); return false;\'>');
	});

	test('should handle non-resource links - simple rendering', () => {
		const r = linkReplacement('https://example.com/test', { linkRenderingType: 2 }).html;
		expect(r).toBe('<a data-from-md href=\'https://example.com/test\'>');
	});

	test('should handle non-resource links with single quotes in it', () => {
		// Handles a link such as:
		// [Google](https://www.goo'onclick=javascript:alert(/1/);f=')
		const r = linkReplacement('https://www.goo\'onclick=javascript:alert(/1/);f=\'', { linkRenderingType: 1 }).html;
		expect(r).toBe('<a data-from-md href=\'https://www.goo&apos;onclick=javascript:alert(/1/);f=&apos;\' onclick=\'postMessage(&quot;https://www.goo%27onclick=javascript:alert(/1/);f=%27&quot;, { resourceId: &quot;&quot; }); return false;\'>');
	});

	test('should handle resource links - downloaded status', () => {
		const resourceId = 'f6afba55bdf74568ac94f8d1e3578d2c';

		const r = linkReplacement(`:/${resourceId}`, {
			ResourceModel: defaultResourceModel,
			resources: {
				[resourceId]: {
					item: { id: 'test' },
					localState: {
						fetch_status: 2, // FETCH_STATUS_DONE
					},
				},
			},
		}).html;

		expect(r).toBe(`<a data-from-md data-resource-id='${resourceId}' href='#' onclick='postMessage(&quot;joplin://${resourceId}&quot;, { resourceId: &quot;${resourceId}&quot; }); return false;'><span class="resource-icon fa-joplin"></span>`);
	});

	test('should show a locked resource as decrypting, as locked with a tap to unlock, or from its decrypted copy', () => {
		const resourceId = 'f6afba55bdf74568ac94f8d1e3578d2c';
		const ResourceModel = {
			...defaultResourceModel,
			filename: (resource: { id?: string; file_extension?: string }) => `${resource.id}.${resource.file_extension}`,
			fullPath: (resource: { id?: string; file_extension?: string }) => `/resources/${resource.id}.${resource.file_extension}`,
		};
		const render = (noteLock: { path?: string; sessionLocked?: boolean; mismatch?: boolean }) => linkReplacement(`:/${resourceId}`, {
			ResourceModel,
			resources: {
				[resourceId]: {
					item: { id: resourceId, is_locked: 1, file_extension: 'pdf', mime: 'application/pdf' },
					localState: { fetch_status: 2 },
					noteLock,
				},
			},
		});

		expect(render({}).html.indexOf(`<a class="not-loaded-resource resource-status-decrypting" data-resource-id="${resourceId}"><img`)).toBe(0);
		expect(render({ sessionLocked: true }).html.indexOf(`<a class="not-loaded-resource resource-status-locked" data-resource-id="${resourceId}" onclick='postMessage(&quot;joplin://${resourceId}&quot;, { resourceId: &quot;${resourceId}&quot; }); return false;'><img`)).toBe(0);

		const ready = render({ path: `locked-cache/${resourceId}.pdf`, mismatch: true });
		expect(ready.resourceReady).toBe(true);
		expect(ready.resourceFullPath).toBe(`/resources/locked-cache/${resourceId}.pdf`);
		expect(ready.html).toContain('class=\'note-lock-mismatch\'');
	});

	test('should handle resource links - idle status', () => {
		const resourceId = 'f6afba55bdf74568ac94f8d1e3578d2c';

		const r = linkReplacement(`:/${resourceId}`, {
			ResourceModel: defaultResourceModel,
			resources: {
				[resourceId]: {
					item: { id: 'test' },
					localState: {
						fetch_status: 0, // FETCH_STATUS_IDLE
					},
				},
			},
		}).html;

		// Since the icon is embedded as SVG, we only check for the prefix
		const expectedPrefix = `<a class="not-loaded-resource resource-status-notDownloaded" data-resource-id="${resourceId}"><img src="data:image/svg+xml;utf8`;
		expect(r.indexOf(expectedPrefix)).toBe(0);
	});

	test('should create ontouch listeners to handle longpress', () => {
		const resourceId = 'e6afba55bdf74568ac94f8d1e3578d2c';

		const linkHtml = linkReplacement(`:/${resourceId}`, {
			ResourceModel: defaultResourceModel,
			resources: {
				[resourceId]: {
					item: { id: 'test' },
					localState: {
						fetch_status: 2, // FETCH_STATUS_DONE
					},
				},
			},
			enableLongPress: true,
		}).html;

		expect(linkHtml).toContain('ontouchstart');
		expect(linkHtml).toContain('ontouchend');
		expect(linkHtml).toContain('ontouchcancel');
	});

	test('should show Joplin Icon for internal link by default', () => {
		const resourceId = 'e6afba55bdf74568ac94f8d1e3578d2c';
		const linkHtml = linkReplacement(`:/${resourceId}`, {
			ResourceModel: defaultResourceModel,
			resources: {},
			showNoteLinkIcon: true,
		}).html;
		expect(linkHtml).toContain('<span class="resource-icon fa-joplin"></span>');
	});

	test('should not include Joplin Icon for internal link if configuration is not enabled', () => {
		const resourceId = 'e6afba55bdf74568ac94f8d1e3578d2c';
		const linkHtml = linkReplacement(`:/${resourceId}`, {
			ResourceModel: defaultResourceModel,
			resources: {},
			showNoteLinkIcon: false,
		}).html;
		expect(linkHtml).not.toContain('<span class="resource-icon fa-joplin"></span>');
	});
});
