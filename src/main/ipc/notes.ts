import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import {
  listNotes,
  getNote,
  createNote,
  quickCreateNote,
  updateNote,
  deleteNote,
  deleteAllDone as deleteAllDoneNotes,
  saveImage as saveNoteImage,
  readImage as readNoteImage,
} from '../notes-store';

export function registerNotesHandlers(): void {
  ipcMain.handle(IPC.NOTES_LIST, async (_event, projectId: string) => {
    return listNotes(projectId);
  });

  ipcMain.handle(IPC.NOTES_GET, async (_event, payload: { projectId: string; noteId: string }) => {
    return getNote(payload.projectId, payload.noteId);
  });

  ipcMain.handle(IPC.NOTES_CREATE, async (_event, projectId: string) => {
    return createNote(projectId);
  });

  ipcMain.handle(IPC.NOTES_QUICK_CREATE, async (_event, payload: { projectId: string; body: string; images?: string[] }) => {
    return quickCreateNote(payload.projectId, payload.body, payload.images ?? []);
  });

  ipcMain.handle(IPC.NOTES_UPDATE, async (_event, payload: { projectId: string; noteId: string; patch: { title?: string; isDone?: boolean; body?: string; images?: string[] } }) => {
    return updateNote(payload.projectId, payload.noteId, payload.patch);
  });

  ipcMain.handle(IPC.NOTES_DELETE, async (_event, payload: { projectId: string; noteId: string }) => {
    await deleteNote(payload.projectId, payload.noteId);
  });

  ipcMain.handle(IPC.NOTES_DELETE_ALL_DONE, async (_event, projectId: string): Promise<number> => {
    return deleteAllDoneNotes(projectId);
  });

  ipcMain.handle(IPC.NOTES_SAVE_IMAGE, async (_event, payload: { projectId: string; buffer: ArrayBuffer; ext: string }): Promise<string> => {
    return saveNoteImage(payload.projectId, payload.buffer, payload.ext);
  });

  ipcMain.handle(IPC.NOTES_READ_IMAGE, async (_event, payload: { projectId: string; filename: string }): Promise<ArrayBuffer | null> => {
    return readNoteImage(payload.projectId, payload.filename);
  });
}
