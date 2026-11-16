export function createPaymentQrImage(qr, { amount, category, address, price, note }, translate) {
  const fields = [
    [translate('Amount'), translate(`${amount} token base units`)],
    [translate('Recipient address'), address],
    [translate('Token category ID'), category],
  ];
  if (price) fields.push([translate('Indicative token price'), price]);
  if (note) fields.push([translate('Sharing note'), note]);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  context.font = '20px monospace';
  const wrapped = fields.map(([label, value]) => [label, value.split(/\r?\n/).flatMap((line) => {
    const lines = [];
    let current = '';
    let length = 0;
    for (const character of line) {
      if (length === 40 || context.measureText(current + character).width > 560) {
        lines.push(current);
        current = '';
        length = 0;
      }
      current += character;
      length++;
    }
    lines.push(current);
    return lines;
  })]);
  canvas.width = 640;
  canvas.height = 430 + wrapped.reduce((height, [, lines]) => height + 40 + lines.length * 26, 0) + 92;

  context.fillStyle = '#000000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = false;
  context.drawImage(qr, 130, 24, 380, 380);
  context.fillStyle = '#ffffff';
  context.textBaseline = 'top';
  let y = 430;
  for (const [label, lines] of wrapped) {
    context.font = 'bold 20px sans-serif';
    context.fillText(label, 40, y);
    y += 28;
    context.font = '20px monospace';
    for (const line of lines) {
      context.fillText(line, 40, y);
      y += 26;
    }
    y += 12;
  }
  context.save();
  context.translate(290, y + 34);
  context.fillStyle = '#0ac18e';
  context.beginPath();
  context.arc(0, 0, 24, 0, 2 * Math.PI);
  context.fill();
  context.rotate(Math.PI / 12);
  context.fillStyle = '#ffffff';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = 'bold 34px sans-serif';
  context.fillText('₿', 0, 1);
  context.restore();
  context.textBaseline = 'middle';
  context.font = 'bold 20px sans-serif';
  context.fillText('BCH', 325, y + 34);
  return canvas;
}
