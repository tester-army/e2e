/** Buffered upload mode remains an explicit closed transport choice. */
import { web, type FileUploadMode } from '../../src/index.ts';

const mode: FileUploadMode = 'buffered';
web({ fileUploads: mode });
web({ fileUploads: 'path' });
// @ts-expect-error Unknown modes do not silently fall back to path uploads.
web({ fileUploads: 'automatic' });
// @ts-expect-error A truthy value is not an upload policy.
web({ fileUploads: true });
