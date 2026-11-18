import Logger from '@joplin/utils/Logger';
import eventManager, { EventName } from '../../eventManager';
import Resource from '../../models/Resource';
import Setting from '../../models/Setting';
import shim from '../../shim';
import { ResourceEntity } from '../database/types';
import NoteLockService from './NoteLockService';
import isNoteLockEnabled from './isNoteLockEnabled';

const logger = Logger.create('NoteLockResourceCache');

// Inside the resource directory, since the mobile viewers can only read files from there.
const cacheDirName = 'locked-cache';

// Decrypted copies of locked attachments, so the viewers and editors can show them. A copy is made when a note
// shows the attachment, kept for when the note is opened again, and removed when the session locks.
export default class NoteLockResourceCache {

	// Bumped to abandon the files being decrypted, when the note is left or the copies are removed.
	private static generation_ = 0;
	// The blob version each copy was made from, so a changed file is decrypted again.
	private static ready_: Record<string, number> = {};
	private static loading_: Record<string, Promise<string>> = {};
	private static clearing_: Promise<void> = null;

	// Copies left by a run that ended without removing them are removed at startup.
	public static async initialize() {
		eventManager.on(EventName.NoteLockSessionChange, event => {
			if (!event.unlocked) void this.clear();
		});
		await this.clear();
	}

	public static dir() {
		return `${Setting.value('resourceDir')}/${cacheDirName}`;
	}

	// Relative to the resource directory, which the viewers use as their base.
	public static relativePath(resource: ResourceEntity) {
		return `${cacheDirName}/${Resource.filename(resource)}`;
	}

	public static path(resource: ResourceEntity) {
		return `${Setting.value('resourceDir')}/${this.relativePath(resource)}`;
	}

	public static isReady(resource: ResourceEntity) {
		return this.ready_[resource.id] === resource.blob_updated_time;
	}

	// Decrypts the file of a locked attachment, or reuses the copy made before. The session must be unlocked.
	public static async load(resource: ResourceEntity): Promise<string> {
		if (this.clearing_) await this.clearing_;
		if (this.isReady(resource) && await shim.fsDriver().exists(this.path(resource))) return this.path(resource);
		if (!this.loading_[resource.id]) {
			const generation = this.generation_;
			this.loading_[resource.id] = (async () => {
				try {
					const path = this.path(resource);
					await shim.fsDriver().mkdir(this.dir());
					await NoteLockService.withDecryptedKey(scoped => scoped.decryptFile(Resource.fullPath(resource), path, () => this.generation_ !== generation));
					this.ready_[resource.id] = resource.blob_updated_time;
					return path;
				} finally {
					delete this.loading_[resource.id];
				}
			})();
		}
		return this.loading_[resource.id];
	}

	// The file to open, save or share: for a locked attachment its decrypted copy, which needs the session unlocked.
	public static async plainPath(resource: ResourceEntity) {
		if (isNoteLockEnabled() && resource.is_locked) return this.load(resource);
		return Resource.fullPath(resource);
	}

	// For when a note is left: its attachments stop decrypting, and the finished copies are kept.
	public static cancelLoading() {
		this.generation_++;
	}

	// Run when the session locks, at startup and when the app quits. Loads started meanwhile wait for it.
	public static async clear() {
		if (!this.clearing_) {
			this.clearing_ = (async () => {
				try {
					this.cancelLoading();
					await Promise.allSettled(Object.values(this.loading_));
					this.ready_ = {};
					await shim.fsDriver().remove(this.dir());
				} catch (error) {
					logger.error('Could not remove the decrypted attachments:', error);
				} finally {
					this.clearing_ = null;
				}
			})();
		}
		return this.clearing_;
	}
}
