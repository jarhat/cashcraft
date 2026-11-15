export function createPaymentQrImage(qr, amount, category, translate) {
  const amountLines = amount.match(/.{1,40}/g);
  const categoryLines = category.match(/.{1,40}/g);
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 474 + (amountLines.length + categoryLines.length) * 26 + 70;

  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = false;
  context.drawImage(qr, 130, 24, 380, 380);
  context.fillStyle = '#07111b';
  context.textBaseline = 'top';
  context.font = 'bold 20px sans-serif';
  context.fillText(translate('Amount'), 40, 430);
  context.font = '20px monospace';
  let y = 458;
  for (const line of amountLines) {
    context.fillText(line, 40, y);
    y += 26;
  }
  context.font = 'bold 20px sans-serif';
  context.fillText(translate('Token category ID'), 40, y + 12);
  context.font = '20px monospace';
  y += 40;
  for (const line of categoryLines) {
    context.fillText(line, 40, y);
    y += 26;
  }
  return canvas;
}
