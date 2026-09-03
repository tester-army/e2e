import { readHostile } from '../../../lib/hostile';
import { NotesClient } from './notes-client';

export const dynamic = 'force-dynamic';

export default function NotesPage() {
  return <NotesClient initial={readHostile()} />;
}
