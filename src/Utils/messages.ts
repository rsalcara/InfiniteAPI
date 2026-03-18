// Apply all metadata updates in sequence without nested conditionals
if (!imageMessage.jpegThumbnail) imageMessage.jpegThumbnail = buffer.toString('base64')
if (!imageMessage.width && original.width) imageMessage.width = original.width
if (!imageMessage.height && original.height) imageMessage.height = original.height