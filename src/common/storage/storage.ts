import { randomBytes } from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import { env } from '../../config/env.js';
import { AppError } from '../errors.js';

/*
 * File storage for certificate images. Files are only ever added: issued certificates keep
 * pointing at the signature and stamp they were issued with, so nothing is deleted or replaced.
 */

export interface StorageProvider {
  readonly name: 'cloudinary' | 'memory' | 'none';
  /** Stores a PNG under `key` (no extension) and returns its public HTTPS URL. */
  upload(buffer: Buffer, key: string): Promise<string>;
}

class CloudinaryStorage implements StorageProvider {
  readonly name = 'cloudinary';

  constructor(cloudName: string, apiKey: string, apiSecret: string) {
    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
      secure: true,
    });
  }

  upload(buffer: Buffer, key: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          public_id: key,
          resource_type: 'image',
          format: 'png',
          overwrite: false,
          unique_filename: false,
        },
        (error, result) => {
          if (error || !result?.secure_url) {
            reject(new Error(error?.message ?? 'Cloudinary returned no URL'));
          } else {
            resolve(result.secure_url);
          }
        },
      );
      stream.end(buffer);
    });
  }
}

/** Tests only: keeps files in this process. */
export class MemoryStorage implements StorageProvider {
  readonly name = 'memory';
  readonly files = new Map<string, Buffer>();

  upload(buffer: Buffer, key: string): Promise<string> {
    this.files.set(key, buffer);
    return Promise.resolve(`https://storage.test/${key}.png`);
  }
}

class NoStorage implements StorageProvider {
  readonly name = 'none';

  upload(): Promise<string> {
    return Promise.reject(
      new AppError('SERVICE_UNAVAILABLE', 'Image storage is not set up on the server yet.'),
    );
  }
}

function createStorage(): StorageProvider {
  const {
    CLOUDINARY_CLOUD_NAME: cloud,
    CLOUDINARY_API_KEY: key,
    CLOUDINARY_API_SECRET: secret,
  } = env;
  const provider = env.STORAGE_PROVIDER ?? (cloud && key && secret ? 'cloudinary' : 'none');
  if (provider === 'cloudinary' && cloud && key && secret) {
    return new CloudinaryStorage(cloud, key, secret);
  }
  if (provider === 'memory') return new MemoryStorage();
  return new NoStorage();
}

export const storage: StorageProvider = createStorage();

/**
 * A storage key that cannot be guessed (and holds no student data),
 * e.g. certificates/signature-1764054000000-9f2c41ab7d03e6a1.
 */
export const newImageKey = (kind: 'signature' | 'stamp'): string =>
  `certificates/${kind}-${Date.now()}-${randomBytes(8).toString('hex')}`;

/** Uploads, turning provider failures into a clean 503 for the client. */
export async function uploadImage(buffer: Buffer, key: string): Promise<string> {
  try {
    return await storage.upload(buffer, key);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('SERVICE_UNAVAILABLE', 'Could not save the image. Try again.', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
