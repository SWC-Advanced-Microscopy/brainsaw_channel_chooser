/* A zip file, written by hand.
 *
 * Stored (uncompressed) entries only. That is the whole trick: a zip with no
 * compression is just each file's bytes with a header in front, a directory at
 * the end, and a CRC of each. It costs about eighty lines and no dependency,
 * which matters here because the page has none and is served as static files.
 *
 * Nothing is lost by not deflating: a PNG is already compressed, and the CSVs
 * are a few tens of kB.
 */
(function (SV) {
  'use strict';

  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  }());

  /* CRC-32 of a Uint8Array, which every zip entry carries twice - once in its
   * local header and once in the central directory. */
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* Text to bytes, for the CSV and README entries. Exported as SV.zipText. */
  function utf8(str) { return new TextEncoder().encode(str); }

  /* Bytes out of a canvas's data: URL, without a round trip through fetch(). */
  function fromDataURL(url) {
    var bin = atob(url.slice(url.indexOf(',') + 1));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* MS-DOS date and time, which is what a zip records. */
  function dosStamp(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  /* files: [{ name, data: Uint8Array }] -> Blob. `name` may contain slashes to
   * put entries in a folder; `when` is the timestamp to stamp them all with,
   * defaulting to now. */
  function zip(files, when) {
    var stamp = dosStamp(when || new Date());
    var parts = [], dir = [], offset = 0;

    files.forEach(function (f) {
      var name = utf8(f.name);
      var crc = crc32(f.data);
      var head = new DataView(new ArrayBuffer(30));
      head.setUint32(0, 0x04034b50, true);   // local file header
      head.setUint16(4, 20, true);           // version needed
      head.setUint16(6, 0x0800, true);       // flags: names are UTF-8
      head.setUint16(8, 0, true);            // method: stored
      head.setUint16(10, stamp.time, true);
      head.setUint16(12, stamp.date, true);
      head.setUint32(14, crc, true);
      head.setUint32(18, f.data.length, true);
      head.setUint32(22, f.data.length, true);
      head.setUint16(26, name.length, true);
      head.setUint16(28, 0, true);           // no extra field
      parts.push(new Uint8Array(head.buffer), name, f.data);

      var ent = new DataView(new ArrayBuffer(46));
      ent.setUint32(0, 0x02014b50, true);    // central directory entry
      ent.setUint16(4, 20, true);            // version made by
      ent.setUint16(6, 20, true);
      ent.setUint16(8, 0x0800, true);
      ent.setUint16(10, 0, true);
      ent.setUint16(12, stamp.time, true);
      ent.setUint16(14, stamp.date, true);
      ent.setUint32(16, crc, true);
      ent.setUint32(20, f.data.length, true);
      ent.setUint32(24, f.data.length, true);
      ent.setUint16(28, name.length, true);
      ent.setUint32(42, offset, true);       // where its local header sits
      dir.push(new Uint8Array(ent.buffer), name);

      offset += 30 + name.length + f.data.length;
    });

    var dirSize = dir.reduce(function (n, b) { return n + b.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);      // end of central directory
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, dirSize, true);
    end.setUint32(16, offset, true);

    return new Blob(parts.concat(dir, [new Uint8Array(end.buffer)]),
      { type: 'application/zip' });
  }

  SV.zip = zip;
  SV.zipText = utf8;
  SV.zipFromDataURL = fromDataURL;
}(window.SV = window.SV || {}));
