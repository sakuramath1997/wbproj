import { describe, it, expect } from 'vitest';
import {
  createNewProject,
  addBoard,
  getBoardUuid,
  getBoardIdFromUuid,
} from '../project';

// ========================================
// createNewProject
// ========================================

describe('createNewProject', () => {
  it('creates a project with correct name', () => {
    const project = createNewProject('My Project');
    expect(project.config.project.name).toBe('My Project');
    expect(project.config.project.version).toBe('4.0');
  });

  it('creates one initial board', () => {
    const project = createNewProject('Test');
    expect(project.config.boards.size).toBe(1);
    expect(project.config.boards.has('0001')).toBe(true);
    expect(project.boards.has('0001')).toBe(true);
    expect(project.boards.get('0001')).toEqual([]);
  });

  it('registers a board asset in assetIndex', () => {
    const project = createNewProject('Test');
    const uuid = getBoardUuid(project, '0001');
    expect(uuid).toBeDefined();
    const asset = project.assetIndex.byUuid.get(uuid!);
    expect(asset).toBeDefined();
    expect(asset!.type).toBe('board');
    expect(asset!.relativePath).toBe('boards/0001.wbelx');
  });

  it('board info has expected defaults', () => {
    const project = createNewProject('Test');
    const board = project.config.boards.get('0001');
    expect(board?.name).toBe('Board 1');
    expect(board?.displayOrder).toBe(1);
  });

  it('creates empty asset files and snapshots', () => {
    const project = createNewProject('Test');
    expect(project.assetFiles.size).toBe(0);
    expect(project.snapshots.size).toBe(0);
    expect(project.thumbnails.size).toBe(0);
  });
});

// ========================================
// addBoard
// ========================================

describe('addBoard', () => {
  it('adds a board with incremented id', () => {
    const project = createNewProject('Test');
    const newId = addBoard(project, 'Second Board');
    expect(newId).toBe('0002');
    expect(project.config.boards.has('0002')).toBe(true);
    expect(project.boards.has('0002')).toBe(true);
    expect(project.boards.get('0002')).toEqual([]);
  });

  it('sets correct display order', () => {
    const project = createNewProject('Test');
    addBoard(project, 'Board 2');
    const board = project.config.boards.get('0002');
    expect(board?.displayOrder).toBe(2);
  });

  it('creates wbasset for the new board', () => {
    const project = createNewProject('Test');
    const newId = addBoard(project, 'Board 2');
    const uuid = getBoardUuid(project, newId);
    expect(uuid).toBeDefined();
    const asset = project.assetIndex.byUuid.get(uuid!);
    expect(asset?.type).toBe('board');
    expect(asset?.relativePath).toBe(`boards/${newId}.wbelx`);
  });

  it('supports adding multiple boards', () => {
    const project = createNewProject('Test');
    addBoard(project, 'Board 2');
    addBoard(project, 'Board 3');
    addBoard(project, 'Board 4');
    expect(project.config.boards.size).toBe(4);
    expect(project.boards.size).toBe(4);
  });
});

// ========================================
// getBoardUuid / getBoardIdFromUuid
// ========================================

describe('getBoardUuid / getBoardIdFromUuid', () => {
  it('round-trips board id to uuid and back', () => {
    const project = createNewProject('Test');
    const uuid = getBoardUuid(project, '0001');
    expect(uuid).toBeDefined();
    const boardId = getBoardIdFromUuid(project, uuid!);
    expect(boardId).toBe('0001');
  });

  it('returns undefined for nonexistent board id', () => {
    const project = createNewProject('Test');
    expect(getBoardUuid(project, '9999')).toBeUndefined();
  });

  it('returns undefined for nonexistent uuid', () => {
    const project = createNewProject('Test');
    expect(getBoardIdFromUuid(project, 'nonexistent')).toBeUndefined();
  });

  it('works for added boards', () => {
    const project = createNewProject('Test');
    const newId = addBoard(project, 'Board 2');
    const uuid = getBoardUuid(project, newId);
    expect(uuid).toBeDefined();
    expect(getBoardIdFromUuid(project, uuid!)).toBe(newId);
  });
});
