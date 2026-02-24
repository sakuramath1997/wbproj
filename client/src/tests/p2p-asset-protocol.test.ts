import { describe, it, expect } from 'vitest';
import {
  MSG,
  CHUNK_SIZE,
  encodeJsonMsg,
  encodeChunkMsg,
  readMsgType,
  decodeJsonPayload,
  decodeChunkMsg,
  isCustomMsg,
  splitIntoChunks,
  mergeChunks,
  createIncomingTransfer,
  addChunk,
  transferProgress,
} from '../utils/p2p-asset-protocol';
import type { AssetMetaPayload, AssetRequestPayload } from '../utils/p2p-asset-protocol';

describe('p2p-asset-protocol', () => {
  // ========================================
  // isCustomMsg
  // ========================================
  describe('isCustomMsg', () => {
    it('type >= 100 はカスタムメッセージ', () => {
      expect(isCustomMsg(new Uint8Array([100, 0, 0]))).toBe(true);
      expect(isCustomMsg(new Uint8Array([106]))).toBe(true);
    });

    it('type < 100 は y-webrtc メッセージ', () => {
      expect(isCustomMsg(new Uint8Array([0, 1, 2]))).toBe(false);
      expect(isCustomMsg(new Uint8Array([4]))).toBe(false);
      expect(isCustomMsg(new Uint8Array([99]))).toBe(false);
    });

    it('空データは false', () => {
      expect(isCustomMsg(new Uint8Array([]))).toBe(false);
    });

    it('ArrayBuffer も受け付ける', () => {
      const buf = new Uint8Array([100, 1]).buffer;
      expect(isCustomMsg(buf)).toBe(true);
    });
  });

  // ========================================
  // JSON メッセージ
  // ========================================
  describe('JSON encode/decode', () => {
    it('ASSET_REQUEST を往復できる', () => {
      const payload: AssetRequestPayload = { uuid: '550e8400-e29b-41d4-a716-446655440000' };
      const encoded = encodeJsonMsg(MSG.ASSET_REQUEST, payload);

      expect(readMsgType(encoded)).toBe(MSG.ASSET_REQUEST);
      const decoded = decodeJsonPayload<AssetRequestPayload>(encoded);
      expect(decoded.uuid).toBe(payload.uuid);
    });

    it('ASSET_META を往復できる', () => {
      const payload: AssetMetaPayload = {
        uuid: '550e8400-e29b-41d4-a716-446655440000',
        fileName: 'test.png',
        mimeType: 'image/png',
        fileSize: 12345,
        totalChunks: 3,
      };
      const encoded = encodeJsonMsg(MSG.ASSET_META, payload);

      expect(readMsgType(encoded)).toBe(MSG.ASSET_META);
      const decoded = decodeJsonPayload<AssetMetaPayload>(encoded);
      expect(decoded).toEqual(payload);
    });

    it('PROJECT_META_RES を往復できる', () => {
      const assets = [
        { uuid: 'abc', type: 'image', originalName: 'a.png', mimeType: 'image/png', fileSize: 100, relativePath: 'assets/a.png', referencedBy: ['board1'], allAncestors: [] },
      ];
      const encoded = encodeJsonMsg(MSG.PROJECT_META_RES, { assets });
      expect(readMsgType(encoded)).toBe(MSG.PROJECT_META_RES);
      const decoded = decodeJsonPayload<{ assets: typeof assets }>(encoded);
      expect(decoded.assets).toEqual(assets);
    });
  });

  // ========================================
  // チャンクメッセージ（バイナリ）
  // ========================================
  describe('chunk encode/decode', () => {
    it('UUID + chunkIndex + data を往復できる', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const chunkData = new Uint8Array([10, 20, 30, 40, 50]);
      const encoded = encodeChunkMsg(uuid, 42, chunkData);

      expect(readMsgType(encoded)).toBe(MSG.ASSET_CHUNK);
      const decoded = decodeChunkMsg(encoded);
      expect(decoded.uuid).toBe(uuid);
      expect(decoded.chunkIndex).toBe(42);
      expect(decoded.chunk).toEqual(chunkData);
    });

    it('大きなチャンクインデックスも正しい', () => {
      const uuid = '00000000-0000-0000-0000-000000000001';
      const data = new Uint8Array([0xFF]);
      const encoded = encodeChunkMsg(uuid, 65535, data);
      const decoded = decodeChunkMsg(encoded);
      expect(decoded.chunkIndex).toBe(65535);
    });

    it('空データのチャンクも正しい', () => {
      const uuid = '00000000-0000-0000-0000-000000000002';
      const encoded = encodeChunkMsg(uuid, 0, new Uint8Array(0));
      const decoded = decodeChunkMsg(encoded);
      expect(decoded.uuid).toBe(uuid);
      expect(decoded.chunkIndex).toBe(0);
      expect(decoded.chunk.length).toBe(0);
    });
  });

  // ========================================
  // チャンク分割 / 結合
  // ========================================
  describe('splitIntoChunks / mergeChunks', () => {
    it('CHUNK_SIZE より小さいデータは 1 チャンク', () => {
      const data = new ArrayBuffer(100);
      new Uint8Array(data).fill(0xAB);
      const chunks = splitIntoChunks(data);
      expect(chunks.length).toBe(1);
      expect(chunks[0].length).toBe(100);
    });

    it('CHUNK_SIZE ちょうどは 1 チャンク', () => {
      const data = new ArrayBuffer(CHUNK_SIZE);
      const chunks = splitIntoChunks(data);
      expect(chunks.length).toBe(1);
    });

    it('CHUNK_SIZE + 1 は 2 チャンク', () => {
      const data = new ArrayBuffer(CHUNK_SIZE + 1);
      const chunks = splitIntoChunks(data);
      expect(chunks.length).toBe(2);
      expect(chunks[0].length).toBe(CHUNK_SIZE);
      expect(chunks[1].length).toBe(1);
    });

    it('分割→結合で元データが復元される', () => {
      const original = new Uint8Array(CHUNK_SIZE * 3 + 500);
      for (let i = 0; i < original.length; i++) original[i] = i % 256;

      const chunks = splitIntoChunks(original.buffer);
      expect(chunks.length).toBe(4);

      const chunkMap = new Map<number, Uint8Array>();
      chunks.forEach((c, i) => chunkMap.set(i, c));

      const merged = mergeChunks(chunkMap, chunks.length);
      const result = new Uint8Array(merged);
      expect(result).toEqual(original);
    });

    it('空データは空チャンク 1 個', () => {
      const chunks = splitIntoChunks(new ArrayBuffer(0));
      expect(chunks.length).toBe(1);
      expect(chunks[0].length).toBe(0);
    });
  });

  // ========================================
  // 受信バッファ
  // ========================================
  describe('IncomingTransfer', () => {
    const meta: AssetMetaPayload = {
      uuid: 'test-uuid-1234',
      fileName: 'test.png',
      mimeType: 'image/png',
      fileSize: CHUNK_SIZE * 2 + 100,
      totalChunks: 3,
    };

    it('進捗が 0 → 1.0 まで正しく推移する', () => {
      const transfer = createIncomingTransfer(meta);
      expect(transferProgress(transfer)).toBe(0);

      addChunk(transfer, 0, new Uint8Array(CHUNK_SIZE));
      expect(transferProgress(transfer)).toBeCloseTo(1 / 3);

      addChunk(transfer, 1, new Uint8Array(CHUNK_SIZE));
      expect(transferProgress(transfer)).toBeCloseTo(2 / 3);

      const complete = addChunk(transfer, 2, new Uint8Array(100));
      expect(complete).toBe(true);
      expect(transferProgress(transfer)).toBe(1);
    });

    it('重複チャンクは無視される', () => {
      const transfer = createIncomingTransfer(meta);
      addChunk(transfer, 0, new Uint8Array(CHUNK_SIZE));
      const dup = addChunk(transfer, 0, new Uint8Array(CHUNK_SIZE)); // 重複
      expect(dup).toBe(false);
      expect(transfer.receivedChunks.size).toBe(1);
    });

    it('順序に関係なくチャンクを受信できる', () => {
      const transfer = createIncomingTransfer(meta);
      addChunk(transfer, 2, new Uint8Array(100));
      addChunk(transfer, 0, new Uint8Array(CHUNK_SIZE));
      const complete = addChunk(transfer, 1, new Uint8Array(CHUNK_SIZE));
      expect(complete).toBe(true);
    });

    it('totalChunks=0 のとき進捗は 1', () => {
      const emptyMeta = { ...meta, totalChunks: 0 };
      const transfer = createIncomingTransfer(emptyMeta);
      expect(transferProgress(transfer)).toBe(1);
    });
  });
});
