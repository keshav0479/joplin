import Logger from '@joplin/utils/Logger';
import eventManager, { EventName } from '../../eventManager';
import Resource from '../../models/Resource';
import { ResourceLocalStateEntity } from '../database/types';
import type { AttachedResources } from '../../utils/attachedResources';
import isNoteLockEnabled from './isNoteLockEnabled';
import NoteLockResourceCache from './NoteLockResourceCache';
import NoteLockSession from './NoteLockSession';

const logger = Logger.create('noteLockResourceInfos');

// Adds what the viewers need for the attachments of a note under note lock: the decrypted copy of a locked
// attachment once it is ready, whether the session is locked, and whether its lock differs from the note's.
// Locked attachments with no copy yet start decrypting in the background, and a NoteLockResourceDecrypted
// event follows each one, so the note is shown again with it.
const noteLockResourceInfos = (resources: AttachedResources, noteIsLocked: boolean): AttachedResources => {
	if (!isNoteLockEnabled()) return resources;
	const sessionLocked = !NoteLockSession.instance().isUnlocked();
	const output: AttachedResources = {};
	for (const [id, info] of Object.entries(resources)) {
		const isLocked = !!info.item?.is_locked;
		const mismatch = !!info.item && isLocked !== noteIsLocked;
		if (!isLocked && !mismatch) {
			output[id] = info;
			continue;
		}
		const isReady = isLocked && NoteLockResourceCache.isReady(info.item);
		output[id] = { ...info, noteLock: { path: isReady ? NoteLockResourceCache.relativePath(info.item) : undefined, sessionLocked, mismatch } };
		if (isLocked && !isReady && !sessionLocked && (info.localState as ResourceLocalStateEntity)?.fetch_status === Resource.FETCH_STATUS_DONE) {
			void (async () => {
				try {
					await NoteLockResourceCache.load(info.item);
					eventManager.emit(EventName.NoteLockResourceDecrypted, { id });
				} catch (error) {
					// Cancelled when the note is left or the session locks, which shows it again anyway.
					logger.info(`Could not decrypt attachment ${id}:`, error);
				}
			})();
		}
	}
	return output;
};

export default noteLockResourceInfos;
