// FFmpeg owns muxing. This parser only frames its bounded stdout byte stream.
export class MP4Parser {
  constructor(onInit, onFragment, maxBytes = 16 * 1024 * 1024) {
    Object.assign(this, { onInit, onFragment, maxBytes });
    this.pending = Buffer.alloc(0); this.init = []; this.initBytes = 0; this.moof = null;
  }
  push(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 8) {
      let size = this.pending.readUInt32BE(0), header = 8;
      if (size === 1) {
        if (this.pending.length < 16) return;
        const large = this.pending.readBigUInt64BE(8);
        if (large > BigInt(this.maxBytes)) throw Error('MP4 box exceeds limit');
        size = Number(large); header = 16;
      }
      if (size < header || size > this.maxBytes) throw Error('Invalid MP4 box size');
      if (this.pending.length < size) break;
      const box = Buffer.from(this.pending.subarray(0, size));
      const type = box.toString('ascii', 4, 8);
      this.pending = this.pending.subarray(size);
      if (type === 'ftyp' || type === 'moov') {
        this.init.push(box); this.initBytes += box.length;
        if (this.initBytes > this.maxBytes) throw Error('MP4 initialization exceeds limit');
        if (type === 'moov') {
          const init = Buffer.concat(this.init);
          // avcC starts with version, profile, compatibility and level.
          const index = init.indexOf(Buffer.from('avcC'));
          if (index < 0 || index + 8 > init.length) throw Error('Missing AVC configuration');
          const codec = 'avc1.' + init.subarray(index + 5, index + 8).toString('hex');
          this.onInit(init, codec); this.init = []; this.initBytes = 0;
        }
      } else if (type === 'moof') {
        if (this.moof) throw Error('Missing mdat');
        this.moof = box;
      } else if (type === 'mdat') {
        if (!this.moof) throw Error('Missing moof');
        if (this.moof.length + box.length > this.maxBytes) throw Error('Fragment exceeds limit');
        this.onFragment(Buffer.concat([this.moof, box])); this.moof = null;
      }
    }
    if (this.pending.length > this.maxBytes) throw Error('MP4 queue exceeds limit');
  }
}
