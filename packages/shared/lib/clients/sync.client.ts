import { Client, Connection, ScheduleOverlapPolicy, ScheduleDescription } from '@temporalio/client';
import type { NangoConnection } from '../models/Connection.js';
import ms from 'ms';
import fs from 'fs-extra';
import type { Config as ProviderConfig } from '../models/Provider.js';
import type { NangoIntegrationData, NangoConfig, NangoIntegration } from '../integrations/index.js';
import { Sync, SyncStatus, SyncType, ScheduleStatus, SyncCommand, SyncWithSchedule } from '../models/Sync.js';
import type { LogLevel, LogAction } from '../models/Activity.js';
import { TASK_QUEUE } from '../constants.js';
import { createActivityLog, createActivityLogMessage, createActivityLogMessageAndEnd } from '../services/activity/activity.service.js';
import { createSyncJob } from '../services/sync/job.service.js';
import { getInterval } from '../services/nango-config.service.js';
import { getSyncConfig } from '../services/sync/config.service.js';
import environmentService from '../services/environment.service.js';
import { createSchedule as createSyncSchedule } from '../services/sync/schedule.service.js';
import connectionService from '../services/connection.service.js';
import configService from '../services/config.service.js';
import { createSync } from '../services/sync/sync.service.js';
import errorManager from '../utils/error.manager.js';
import { isProd } from '../utils/utils.js';

const generateWorkflowId = (sync: Sync, syncName: string, connectionId: string) => `${TASK_QUEUE}.${syncName}.${connectionId}-${sync.id}`;
const generateScheduleId = (sync: Sync, syncName: string, connectionId: string) => `${TASK_QUEUE}.${syncName}.${connectionId}-schedule-${sync.id}`;

const OVERLAP_POLICY: ScheduleOverlapPolicy = ScheduleOverlapPolicy.BUFFER_ONE;

const namespace = process.env['TEMPORAL_NAMESPACE'] || 'default';

class SyncClient {
    private static instance: Promise<SyncClient | null>;
    private client: Client | null = null;
    private namespace = namespace;

    private constructor(client: Client) {
        this.client = client;
    }

    static getInstance(): Promise<SyncClient | null> {
        if (!this.instance) {
            this.instance = this.create();
        }
        return this.instance;
    }

    private static async create(): Promise<SyncClient | null> {
        try {
            const connection = await Connection.connect({
                address: process.env['TEMPORAL_ADDRESS'] || 'localhost:7233',
                tls: isProd()
                    ? {
                          clientCertPair: {
                              crt: await fs.readFile(`/etc/secrets/${namespace}.crt`),
                              key: await fs.readFile(`/etc/secrets/${namespace}.key`)
                          }
                      }
                    : false
            });
            const client = new Client({
                connection,
                namespace
            });
            return new SyncClient(client);
        } catch (e) {
            errorManager.report(e, {
                metadata: {
                    namespace,
                    address: process.env['TEMPORAL_ADDRESS'] || 'localhost:7233'
                }
            });
            return null;
        }
    }

    async initiate(nangoConnectionId: number): Promise<void> {
        const nangoConnection = (await connectionService.getConnectionById(nangoConnectionId)) as NangoConnection;
        const nangoConfig = await getSyncConfig(nangoConnection);
        if (!nangoConfig) {
            console.log(
                'Failed to load the Nango config - will not start any syncs! If you expect to see a sync make sure you used the nango cli deploy command'
            );
            return;
        }
        const { integrations }: NangoConfig = nangoConfig;
        const providerConfigKey = nangoConnection?.provider_config_key as string;

        if (!integrations[providerConfigKey]) {
            console.log(`No syncs registered for provider ${providerConfigKey} - will not start any syncs!`);
            return;
        }

        if (!this.client) {
            console.log('Failed to get a Temporal client - will not start any syncs!');
            return;
        }

        const syncConfig: ProviderConfig = (await configService.getProviderConfig(
            nangoConnection?.provider_config_key as string,
            nangoConnection?.environment_id as number
        )) as ProviderConfig;

        const syncObject = integrations[providerConfigKey] as unknown as { [key: string]: NangoIntegration };
        const syncNames = Object.keys(syncObject);
        for (let k = 0; k < syncNames.length; k++) {
            const syncName = syncNames[k] as string;
            const syncData = syncObject[syncName] as unknown as NangoIntegrationData;

            const sync = await createSync(nangoConnectionId, syncName);

            if (sync) {
                await this.startContinuous(nangoConnection, sync, syncConfig, syncName, syncData);
            }
        }
    }

    /**
     * Start Continuous
     * @desc get the connection information and the provider information
     * and kick off an initial sync and also a incremental sync. Also look
     * up any sync configs to call any integration snippet that was setup
     */
    async startContinuous(
        nangoConnection: NangoConnection,
        sync: Sync,
        syncConfig: ProviderConfig,
        syncName: string,
        syncData: NangoIntegrationData,
        debug = false
    ): Promise<void> {
        try {
            const log = {
                level: 'info' as LogLevel,
                success: null,
                action: 'sync' as LogAction,
                start: Date.now(),
                end: Date.now(),
                timestamp: Date.now(),
                connection_id: nangoConnection?.connection_id as string,
                provider_config_key: nangoConnection?.provider_config_key as string,
                provider: syncConfig.provider,
                session_id: sync?.id?.toString() as string,
                environment_id: nangoConnection?.environment_id as number,
                operation_name: syncName
            };
            const activityLogId = await createActivityLog(log);

            const jobId = generateWorkflowId(sync, syncName, nangoConnection?.connection_id as string);

            if (debug) {
                await createActivityLogMessage({
                    level: 'debug',
                    activity_log_id: activityLogId as number,
                    timestamp: Date.now(),
                    content: `Starting sync job ${jobId} for sync ${sync.id}`
                });
            }
            const syncJobId = await createSyncJob(sync.id as string, SyncType.INITIAL, SyncStatus.RUNNING, jobId, activityLogId as number);

            if (!syncJobId) {
                return;
            }

            const handle = await this.client?.workflow.start('initialSync', {
                taskQueue: TASK_QUEUE,
                workflowId: jobId,
                args: [
                    {
                        syncId: sync.id,
                        syncJobId: syncJobId?.id as number,
                        nangoConnection,
                        syncName,
                        activityLogId,
                        debug
                    }
                ]
            });

            const { interval, offset } = getInterval(syncData.runs, new Date());
            const scheduleId = generateScheduleId(sync, syncName, nangoConnection?.connection_id as string);

            await this.client?.schedule.create({
                scheduleId,
                spec: {
                    /**
                     * @see https://nodejs.temporal.io/api/interfaces/client.IntervalSpec
                     */
                    intervals: [
                        {
                            every: interval,
                            offset
                        }
                    ]
                },
                action: {
                    type: 'startWorkflow',
                    workflowType: 'continuousSync',
                    taskQueue: TASK_QUEUE,
                    args: [
                        {
                            syncId: sync.id,
                            activityLogId,
                            nangoConnection,
                            syncName,
                            debug
                        }
                    ]
                }
            });

            await createSyncSchedule(sync.id as string, interval, offset, ScheduleStatus.RUNNING, scheduleId);

            await createActivityLogMessage({
                level: 'info',
                activity_log_id: activityLogId as number,
                content: `Started initial background sync ${handle?.workflowId} and data updated on a schedule ${scheduleId} at ${syncData.runs} in the task queue: ${TASK_QUEUE}`,
                timestamp: Date.now()
            });
        } catch (e) {
            const accountId = (await environmentService.getAccountIdFromEnvironment(nangoConnection.environment_id)) as number;
            errorManager.report(e, {
                accountId: accountId,
                metadata: {
                    syncName,
                    connectionDetails: nangoConnection,
                    syncId: sync.id,
                    syncConfig
                }
            });
        }
    }

    async deleteSyncSchedule(id: string): Promise<boolean> {
        if (!this.client) {
            return false;
        }

        const workflowService = this.client?.workflowService;
        try {
            await workflowService?.deleteSchedule({
                scheduleId: id,
                namespace: this.namespace
            });
            return true;
        } catch (e) {
            errorManager.report(e, {
                metadata: {
                    id
                }
            });
            return false;
        }
    }

    async listSchedules() {
        if (!this.client) {
            return;
        }

        const workflowService = this.client?.workflowService;

        const schedules = await workflowService?.listSchedules({
            namespace: this.namespace
        });

        return schedules;
    }

    async runSyncCommand(syncId: string, command: SyncCommand, activityLogId: number) {
        const scheduleHandle = this.client?.schedule.getHandle(syncId);

        try {
            switch (command) {
                case SyncCommand.PAUSE:
                    await scheduleHandle?.pause();
                    break;
                case SyncCommand.UNPAUSE:
                    await scheduleHandle?.unpause();
                    break;
                case SyncCommand.RUN:
                    await scheduleHandle?.trigger(OVERLAP_POLICY);
                    break;
                case SyncCommand.RUN_FULL:
                    console.warn('Not implemented');
                    break;
            }
        } catch (e) {
            const errorMessage = JSON.stringify(e, ['message', 'name', 'stack'], 2);

            await createActivityLogMessageAndEnd({
                level: 'error',
                activity_log_id: activityLogId as number,
                timestamp: Date.now(),
                content: `The sync command: ${command} failed with error: ${errorMessage}`
            });
        }
    }

    async triggerSyncs(syncs: SyncWithSchedule[]) {
        for (const sync of syncs) {
            try {
                const scheduleHandle = this.client?.schedule.getHandle(sync.schedule_id);
                await scheduleHandle?.trigger(OVERLAP_POLICY);
            } catch (e) {
                errorManager.report(e, {
                    metadata: {
                        syncs
                    }
                });
            }
        }
    }

    async updateSyncSchedule(schedule_id: string, interval: string, offset: number, syncName: string, activityLogId: number) {
        function updateFunction(scheduleDescription: ScheduleDescription) {
            scheduleDescription.spec = {
                intervals: [
                    {
                        every: ms(interval),
                        offset
                    }
                ]
            };
            return scheduleDescription;
        }

        try {
            const scheduleHandle = this.client?.schedule.getHandle(schedule_id);

            await scheduleHandle?.update(updateFunction);

            await createActivityLogMessage({
                level: 'info',
                activity_log_id: activityLogId as number,
                content: `Updated sync "${syncName}" schedule "${schedule_id}" with interval ${interval} and offset ${offset}.`,
                timestamp: Date.now()
            });
        } catch (e) {
            errorManager.report(e, {
                metadata: {
                    syncName,
                    schedule_id,
                    interval,
                    offset
                }
            });
        }
    }
}

export default SyncClient;
