import { v4 as uuid } from 'uuid';
import {
  Failable,
  handleResponse,
  Integration,
  RedisClient,
  RegisterInitServiceInput,
  RegisterInitServiceOutput,
  RegisterUploadServerInput,
  ResetInitServiceInput,
  ResetUploadServerInput,
  RestoreInitServiceInput,
  RestoreInitServiceOutput,
  RestoreUploadServerInput,
} from '@authservice/shared';

const {
  AUTHSERVICE_INTEGRATION_ID,
  AUTHSERVICE_INTEGRATION_API_KEY,
  AUTHSERVICE_SERVICE_HOST,
} = process.env;

interface Config {
  url: string;
  apiKey: string;
}

export class ServerClient {
  readonly integration: Integration;
  readonly url: string;
  readonly apiKey: string;
  private redis = new RedisClient({ prefix: 'authservice-server' });
  readonly sessionDuration = 60 * 24 * 3600;
  readonly tmpStorageDuration = 10 * 60;

  private constructor(integration: Integration, { url, apiKey }: Config) {
    this.integration = integration;
    this.apiKey = apiKey;
    this.url = url;
  }

  public async onRegisterUpload({
    EACRegisterToken,
    apiKey,
  }: RegisterUploadServerInput) {
    return this.replaceTmp(`register:${EACRegisterToken}`, apiKey);
  }

  public async onRestoreUpload({
    EACRestoreToken,
    apiKey,
  }: RestoreUploadServerInput) {
    return this.replaceTmp(`restore:${EACRestoreToken}`, apiKey);
  }

  public async onResetConfirm() {
    const EACResetToken = uuid();
    await this.redis.set(
      `reset:${EACResetToken}`,
      'pending',
      this.tmpStorageDuration
    );
    return EACResetToken;
  }

  public async onResetUpload({
    EACResetToken,
    apiKey,
  }: ResetUploadServerInput) {
    return this.replaceTmp(`reset:${EACResetToken}`, apiKey);
  }

  private async replaceTmp(key: string, value: string): Promise<Failable> {
    const pendingValue = await this.redis.get(key);
    if (pendingValue !== 'pending')
      return { success: false, error: 'No pending value' };
    await this.redis.set(key, value, this.tmpStorageDuration);
    return { success: true };
  }

  public async registerSetupSession(EACRegisterToken: string) {
    return this.setupSession(`register:${EACRegisterToken}`);
  }

  public async restoreSetupSession(EACRestoreToken: string) {
    return this.setupSession(`restore:${EACRestoreToken}`);
  }

  public async resetSetupSession(EACResetToken: string) {
    return this.setupSession(`reset:${EACResetToken}`);
  }

  private async setupSession(
    key: string
  ): Promise<Failable<{ sessionId: string; expiresIn: number }>> {
    const apiKey = await this.redis.get(key);
    if (!apiKey) {
      return { success: false, error: 'Not found' };
    }
    const sessionId = uuid();
    await this.redis.set(`session:${sessionId}`, apiKey, this.sessionDuration);
    await this.redis.del(key);
    return { success: true, sessionId, expiresIn: this.sessionDuration };
  }

  public async initRegister({ email }: RegisterInitServiceInput) {
    try {
      const EACRegisterToken = uuid();
      await this.redis.set(
        `register:${EACRegisterToken}`,
        'pending',
        this.tmpStorageDuration
      );
      const { SVCRegisterToken }: RegisterInitServiceOutput =
        await this.fetchService('register', {
          method: 'POST',
          body: JSON.stringify({ email }),
        });
      return {
        uploadUrl: `${AUTHSERVICE_SERVICE_HOST}/upload/register`,
        SVCRegisterToken,
        EACRegisterToken,
      };
    } catch (error) {
      console.error('Init Register Error: ', error);
    }
  }

  public async initRestore({ email }: RestoreInitServiceInput) {
    try {
      const EACRestoreToken = uuid();
      await this.redis.set(
        `restore:${EACRestoreToken}`,
        'pending',
        this.tmpStorageDuration
      );
      const { SVCRestoreToken }: RestoreInitServiceOutput =
        await this.fetchService('restore', {
          method: 'POST',
          body: JSON.stringify({ email }),
        });
      return {
        uploadUrl: `${AUTHSERVICE_SERVICE_HOST}/upload/restore`,
        SVCRestoreToken,
        EACRestoreToken,
      };
    } catch (error) {
      console.error('Init Restore Error: ', error);
    }
  }

  public async initReset({ email }: ResetInitServiceInput) {
    try {
      await this.fetchService<Failable>('reset', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      return { uploadUrl: `${AUTHSERVICE_SERVICE_HOST}/upload/reset` };
    } catch (error) {
      console.error('Init Reset Error: ', error);
    }
  }

  public static async init(initParams?: {
    integrationId?: number;
    apiKey?: string;
  }) {
    const baseUrl = `${AUTHSERVICE_SERVICE_HOST}/integrations/${initParams?.integrationId || AUTHSERVICE_INTEGRATION_ID}`;
    const baseApiKey = initParams?.apiKey || AUTHSERVICE_INTEGRATION_API_KEY;
    if (!baseApiKey) throw new Error('Api key is required');
    const integration: Integration = await fetch(baseUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${baseApiKey}`,
      },
    }).then((res) => handleResponse<Integration>(res));
    return new ServerClient(integration, { url: baseUrl, apiKey: baseApiKey });
  }

  private async fetchService<T>(
    endpoint: 'register' | 'restore' | 'reset',
    init?: RequestInit
  ) {
    return fetch(`${this.url}/${endpoint}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    }).then((res) => handleResponse<T>(res));
  }
}
