export function setupWikiGlossary(dialog) {
  const terms = [...dialog.querySelectorAll('.wiki-term')];
  const closeTerms = (except) => {
    for (const term of terms) if (term !== except) term.open = false;
  };
  for (const term of terms) {
    term.querySelector('summary').addEventListener('click', () => closeTerms(term));
  }
  dialog.addEventListener('click', (event) => {
    if (!event.target.closest('.wiki-term')) closeTerms();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const open = terms.find((term) => term.open);
    if (!open) return;
    event.preventDefault();
    event.stopPropagation();
    open.open = false;
    open.querySelector('summary').focus();
  });
  dialog.addEventListener('close', () => closeTerms());
}
