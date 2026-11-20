export function updateCategoryIcon(field, icon, { mainnet, loadTokenLogo, logger }) {
  const category = field.value.trim().toLowerCase();
  icon.hidden = !category;
  icon.textContent = '◆';
  if (!mainnet || !/^[0-9a-f]{64}$/.test(category)) return;
  loadTokenLogo(category).then((image) => {
    if (field.value.trim().toLowerCase() !== category) return;
    image.alt = '';
    icon.replaceChildren(image);
  }).catch((error) => logger.warn(`Token logo unavailable for ${category}:`, error));
}
