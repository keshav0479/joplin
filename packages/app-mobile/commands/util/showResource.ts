import NoteLockResourceCache from '@joplin/lib/services/noteLock/NoteLockResourceCache';
import { ResourceEntity } from '@joplin/lib/services/database/types';
import shim from '@joplin/lib/shim';
import Logger from '@joplin/utils/Logger';
import FileViewer from 'react-native-file-viewer';


const logger = Logger.create('showResource');

const showResource = async (item: ResourceEntity) => {
	// A locked attachment opens as its decrypted copy.
	const resourcePath = await NoteLockResourceCache.plainPath(item);
	logger.info(`Opening resource: ${resourcePath}`);

	if (shim.mobilePlatform() === 'web') {
		const url = URL.createObjectURL(await shim.fsDriver().fileAtPath(resourcePath));
		const w = window.open(url, '_blank');
		w?.addEventListener('close', () => {
			URL.revokeObjectURL(url);
		}, { once: true });
	} else {
		await FileViewer.open(resourcePath);
	}
};

export default showResource;
