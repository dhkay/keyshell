'use strict';
if (process.env.KEYSHELL_SIGNED_RELEASE !== '1') throw new Error('Release packaging requires explicit KEYSHELL_SIGNED_RELEASE=1 and native signing credentials. Use package:dev for development.');
require('../electron-builder.cjs');
