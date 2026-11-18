import Api, { RequestMethod } from '../Api';
import Note from '../../../models/Note';
import Resource from '../../../models/Resource';
import Setting from '../../../models/Setting';
import shim from '../../../shim';
import { setupDatabaseAndSynchronizer, supportDir, switchClient } from '../../../testing/test-utils';
import JoplinData from '../../plugins/api/JoplinData';

const attachment = async () => {
	await shim.attachFileToNote(await Note.save({ title: 'note' }), `${supportDir}/photo.jpg`);
	return (await Resource.all())[0];
};

const lockedResource = async () => {
	const resource = await attachment();
	// The file itself is not encrypted here, only the lock state matters to these checks.
	await Resource.save({ id: resource.id, is_locked: 1 });
	return resource;
};

describe('routes/resources', () => {

	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
		Setting.setValue('featureFlag.noteLock', true);
	});

	it('should not let the API read or replace the file of a locked attachment, or change its lock state', async () => {
		const resource = await lockedResource();
		const api = new Api();

		await expect(api.route(RequestMethod.GET, `resources/${resource.id}/file`)).rejects.toThrow('The file of a locked attachment cannot be read or changed through the API');
		await expect(api.route(RequestMethod.PUT, `resources/${resource.id}`, null, null, [{ path: `${supportDir}/photo.jpg` }])).rejects.toThrow('The file of a locked attachment cannot be read or changed through the API');
		await expect(api.route(RequestMethod.PUT, `resources/${resource.id}`, null, JSON.stringify({ is_locked: 0 }))).rejects.toThrow('The lock state of an attachment cannot be changed through the API');
		expect((await api.route(RequestMethod.GET, `resources/${resource.id}`)).id).toBe(resource.id);
		expect((await Resource.load(resource.id)).is_locked).toBe(1);
	});

	it('should not let the API lock an attachment', async () => {
		const resource = await attachment();
		const api = new Api();

		await expect(api.route(RequestMethod.PUT, `resources/${resource.id}`, null, JSON.stringify({ is_locked: 1 }))).rejects.toThrow('The lock state of an attachment cannot be changed through the API');
		expect((await api.route(RequestMethod.GET, `resources/${resource.id}/file`)).body.length).toBeGreaterThan(0);
	});

	it('should not let the file of a locked attachment be replaced or read by plugins', async () => {
		const resource = await lockedResource();

		await expect(Resource.updateResourceBlobContent(resource.id, `${supportDir}/photo.jpg`)).rejects.toThrow('Cannot update the file of a locked attachment');
		await expect(new JoplinData(null).resourcePath(resource.id)).rejects.toThrow('The file of a locked attachment cannot be read by plugins');
	});
});
