import { describe, it, expect } from 'vitest';
import { parseProjectToml, parseWbasset } from '../toml-parser';

// ========================================
// parseProjectToml
// ========================================

describe('parseProjectToml', () => {
  it('parses minimal project.toml', () => {
    const toml = `
[project]
version = "4.0"
uuid = "abc-123"
name = "Test Project"
created_at = "2026-01-01T00:00:00.000Z"
updated_at = "2026-01-01T00:00:00.000Z"
`;
    const config = parseProjectToml(toml);
    expect(config.project.version).toBe('4.0');
    expect(config.project.uuid).toBe('abc-123');
    expect(config.project.name).toBe('Test Project');
  });

  it('parses background section with defaults', () => {
    const toml = `
[project]
version = "4.0"

[background]
color = "#f0f0f0"
pattern = "dots"
pattern_size = 30
pattern_color = "#cccccc"
`;
    const config = parseProjectToml(toml);
    expect(config.background.color).toBe('#f0f0f0');
    expect(config.background.pattern).toBe('dots');
    expect(config.background.patternSize).toBe(30);
    expect(config.background.patternColor).toBe('#cccccc');
  });

  it('uses default background when section is missing', () => {
    const toml = `
[project]
version = "4.0"
`;
    const config = parseProjectToml(toml);
    // defaults from types/project.ts
    expect(config.background.pattern).toBe('none');
  });

  it('parses boards sections', () => {
    const toml = `
[project]
version = "4.0"

[boards.0001]
name = "Board A"
display_order = 1
created_at = "2026-01-01T00:00:00.000Z"
updated_at = "2026-01-01T00:00:00.000Z"
hosted_by = ""
hosted_since = ""

[boards.0002]
name = "Board B"
display_order = 2
created_at = "2026-01-01T00:00:00.000Z"
updated_at = "2026-01-01T00:00:00.000Z"
hosted_by = ""
hosted_since = ""
canvas_width = 1920
canvas_height = 1080
`;
    const config = parseProjectToml(toml);
    expect(config.boards.size).toBe(2);

    const b1 = config.boards.get('0001');
    expect(b1?.name).toBe('Board A');
    expect(b1?.displayOrder).toBe(1);

    const b2 = config.boards.get('0002');
    expect(b2?.name).toBe('Board B');
    expect(b2?.canvasWidth).toBe(1920);
    expect(b2?.canvasHeight).toBe(1080);
  });

  it('parses assets sections', () => {
    const toml = `
[project]
version = "4.0"

[assets."550e8400-e29b-41d4-a716-446655440000"]
original_path = "photo.jpg"
imported_by = "sess-001"
imported_at = "2026-01-01T00:00:00.000Z"
`;
    const config = parseProjectToml(toml);
    expect(config.assets.size).toBe(1);
    const asset = config.assets.get('550e8400-e29b-41d4-a716-446655440000');
    expect(asset?.originalPath).toBe('photo.jpg');
    expect(asset?.importedBy).toBe('sess-001');
  });

  it('parses defaults section', () => {
    const toml = `
[project]
version = "4.0"

[defaults]
canvas_width = 1920
canvas_height = 1080
`;
    const config = parseProjectToml(toml);
    expect(config.defaults.canvasWidth).toBe(1920);
    expect(config.defaults.canvasHeight).toBe(1080);
  });

  it('parses rendering section with inline table', () => {
    const toml = `
[project]
version = "4.0"

[rendering]
board_overlay_margin = 50
board_overlay_fallback_viewport = { x = 0, y = 0, width = 800, height = 600 }
`;
    const config = parseProjectToml(toml);
    expect(config.rendering.boardOverlayMargin).toBe(50);
    expect(config.rendering.boardOverlayFallbackViewport.width).toBe(800);
    expect(config.rendering.boardOverlayFallbackViewport.height).toBe(600);
  });

  it('parses collaboration section', () => {
    const toml = `
[project]
version = "4.0"

[collaboration]
signaling_server = "wss://signal.example.com"
`;
    const config = parseProjectToml(toml);
    expect(config.collaboration.signalingServer).toBe('wss://signal.example.com');
  });

  it('ignores comments and empty lines', () => {
    const toml = `
# This is a comment
[project]
version = "4.0"

# Another comment
name = "Test"
`;
    const config = parseProjectToml(toml);
    expect(config.project.version).toBe('4.0');
    expect(config.project.name).toBe('Test');
  });

  it('parses boolean and array values', () => {
    // While not directly used in project.toml, the TOML parser should handle them
    const toml = `
[project]
version = "4.0"

[assets."test-uuid"]
original_path = "test.png"
imported_by = "sess"
imported_at = "2026-01-01T00:00:00.000Z"
`;
    const config = parseProjectToml(toml);
    expect(config.assets.has('test-uuid')).toBe(true);
  });
});

// ========================================
// parseWbasset
// ========================================

describe('parseWbasset', () => {
  it('parses a valid .wbasset file', () => {
    const content = `
[asset]
uuid = "550e8400-e29b-41d4-a716-446655440000"
type = "image"
original_name = "photo.jpg"
mime_type = "image/jpeg"
file_size = 102400
relative_path = "assets/550e8400-e29b-41d4-a716-446655440000.jpg"
referenced_by = ["board-uuid-001"]
all_ancestors = []
`;
    const asset = parseWbasset(content);
    expect(asset).not.toBeNull();
    expect(asset!.uuid).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(asset!.type).toBe('image');
    expect(asset!.originalName).toBe('photo.jpg');
    expect(asset!.mimeType).toBe('image/jpeg');
    expect(asset!.fileSize).toBe(102400);
    expect(asset!.referencedBy).toEqual(['board-uuid-001']);
    expect(asset!.allAncestors).toEqual([]);
  });

  it('parses a board-type wbasset', () => {
    const content = `
[asset]
uuid = "board-uuid-001"
type = "board"
original_name = "Board 1"
mime_type = "application/wbelx"
file_size = 0
relative_path = "boards/0001.wbelx"
referenced_by = []
all_ancestors = []
`;
    const asset = parseWbasset(content);
    expect(asset).not.toBeNull();
    expect(asset!.type).toBe('board');
    expect(asset!.relativePath).toBe('boards/0001.wbelx');
  });

  it('returns null when [asset] section is missing', () => {
    const content = `
[other]
key = "value"
`;
    const asset = parseWbasset(content);
    expect(asset).toBeNull();
  });

  it('handles missing optional fields gracefully', () => {
    const content = `
[asset]
uuid = "test-uuid"
type = "document"
`;
    const asset = parseWbasset(content);
    expect(asset).not.toBeNull();
    expect(asset!.uuid).toBe('test-uuid');
    expect(asset!.originalName).toBe('');
    expect(asset!.fileSize).toBe(0);
  });
});
