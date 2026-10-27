import { configureSharpCache } from '../src/common/sharp/sharp-cache';

// libvips' file cache keeps handles open, which makes temporary files
// undeletable on Windows. Every Jest worker needs this, so it is applied once
// globally instead of per test file.
configureSharpCache();
