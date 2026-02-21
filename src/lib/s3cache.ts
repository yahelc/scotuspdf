import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

let s3Client: S3Client | null = null;

function getS3Client(): S3Client | null {
  if (!import.meta.env.S3_BUCKET) return null;
  if (!s3Client) {
    s3Client = new S3Client({
      region: import.meta.env.S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: import.meta.env.S3_ACCESS_KEY_ID || '',
        secretAccessKey: import.meta.env.S3_SECRET_ACCESS_KEY || '',
      },
    });
  }
  return s3Client;
}

function getBucket(): string {
  return import.meta.env.S3_BUCKET || '';
}

export async function getCached<T>(key: string): Promise<T | null> {
  const client = getS3Client();
  if (!client) return null;

  try {
    const res = await client.send(new GetObjectCommand({
      Bucket: getBucket(),
      Key: key,
    }));
    const body = await res.Body?.transformToString();
    if (!body) return null;
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

export async function setCache(key: string, data: unknown, maxAge: number = 2592000): Promise<void> {
  const client = getS3Client();
  if (!client) return;

  try {
    await client.send(new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      Body: JSON.stringify(data),
      ContentType: 'application/json',
      CacheControl: `max-age=${maxAge}`,
    }));
  } catch (err) {
    console.error('S3 cache write failed:', err);
  }
}
