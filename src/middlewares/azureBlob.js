import { BlobServiceClient } from '@azure/storage-blob';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = process.env.AZURE_CONTAINER_NAME;

const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
const containerClient = blobServiceClient.getContainerClient(containerName);

export async function uploadBufferToBlob(buffer, originalname, mimetype) {
  const blobName = `${uuidv4()}-${originalname}`;
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  await blockBlobClient.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: mimetype },
  });

  return blockBlobClient.url;
}

// Circular attachments never use public blob URLs or the public upload route.
const circularContainer = () => blobServiceClient.getContainerClient(process.env.CIRCULAR_CONTAINER_NAME || 'msfs-circulars');
async function privateCircularContainer(abortSignal) {
  const container = circularContainer();
  await container.createIfNotExists({abortSignal});
  const properties = await container.getProperties({abortSignal});
  if (properties.blobPublicAccess) throw new Error('The circular attachment container must be private.');
  return container;
}
async function boundedCircularStorage(action) {
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),90000);
  timer.unref?.();
  try {return await action(controller.signal);} finally {clearTimeout(timer);}
}
export async function uploadCircularBlob(buffer, filename, mime) {
  return boundedCircularStorage(async abortSignal=>{
    const container = await privateCircularContainer(abortSignal), key = `${uuidv4()}/${filename}`;
    await container.getBlockBlobClient(key).uploadData(buffer, {abortSignal,blobHTTPHeaders: {blobContentType:mime}});
    return key;
  });
}
export async function downloadCircularBlob(key) {
  return boundedCircularStorage(async abortSignal=>{
    const container = await privateCircularContainer(abortSignal), blob=container.getBlockBlobClient(key);
    const properties=await blob.getProperties({abortSignal});
    if(!properties.contentLength || properties.contentLength>10*1024*1024)throw new Error('Invalid circular attachment size in storage.');
    return blob.downloadToBuffer(0,undefined,{abortSignal,maxRetryRequests:2,concurrency:2});
  });
}
export async function deleteCircularBlob(key) {
  return boundedCircularStorage(async abortSignal=>{
    const container = await privateCircularContainer(abortSignal);
    await container.getBlockBlobClient(key).deleteIfExists({abortSignal});
  });
}
