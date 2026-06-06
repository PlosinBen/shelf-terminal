export type Mode = 'preview' | 'edit';
export type Filter = 'active' | 'done' | 'all';

export interface NoteMeta {
  id: string;
  title: string;
  isDone: boolean;
  created: string;
  updated: string;
}

export interface Note extends NoteMeta {
  body: string;
  images: string[];
}
