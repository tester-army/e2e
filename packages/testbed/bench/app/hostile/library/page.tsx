import { readHostile } from '../../../lib/hostile';
import { LibraryClient } from './library-client';

export const dynamic = 'force-dynamic';

export default function LibraryPage() {
  return <LibraryClient initial={readHostile()} />;
}
