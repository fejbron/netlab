import type { Lab } from '../types';
import { sdDataStorageLabs } from './sd-data-storage';
import { sdDataConsistencyLabs } from './sd-data-consistency';

/* Data and storage: eleven lessons, split across two files for size. */
export const sdDataLabs: Lab[] = [...sdDataStorageLabs, ...sdDataConsistencyLabs];
