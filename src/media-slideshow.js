const MEDIA_BASE = 'https://pub-0dcd642e0e954a94b4fd240efe006ed9.r2.dev/';

const slides = [
  ['private-shadow', '7971982929', 'Private Shadow', 'Privacy', 'Stencil on a peeling wall: CCTV camera beam lights two silhouettes handing a green coin through a torn hole in the wall.'],
  ['get-bch-now-level-clear', '2716f97815', 'Get BCH Now: Level Clear', 'Markets & memes', 'Pixel plumber collects green BCH coins and climbs a flagpole with a BCH flag.'],
  ['ask-again-nicely', '27315605af', 'Ask Again Nicely', 'Banks & power', 'Stencil art: a man begs at a bank cashier desk while a woman hands him a sign saying Ask Again Nicely.'],
  ['bank-run-exit', '8ebb330964', 'Bank Run Exit', 'Banks & power', 'A crowd stands at chained bank doors while a woman points at a green Bitcoin Cash button.'],
  ['get-bch-now-roll-safe', 'c8939c09f1', 'Get BCH Now Roll Safe', 'Markets & memes', 'A smiling man in a green GET BCH.NOW shirt taps his temple.'],
  ['big-mac-meal-close-up', 'fb097723e4', 'BCH Mac Meal, Close Up', 'Priced in BCH', 'A burger meal with fries and a cola, and a green price tag reading 0.043 BCH.'],
  ['bch-now-logo-loop', '63c7ecd864', 'BCH Now Logo Loop', 'Logos & brand', 'White Bitcoin B and NOW on a green background.'],
  ['bitcoin-cash-has-something-for-everyone', 'd88c73b15c', 'Bitcoin Cash has something for everyone', 'Markets & memes', 'A bull bites a green Bitcoin Cash coin while a cat sleeps against it and a duck pecks at it.'],
  ['censored', 'a34bb86d6d', 'Censored', 'Freedom', 'Stencil of a boy cutting red CENSORED tape over his mouth.'],
  ['distracted-by-bch', '3620a6697a', 'Distracted By BCH', 'Markets & memes', 'A man looks at a woman in a green GET BCH. NOW shirt while his girlfriend looks shocked.'],
  ['get-bch-now-kid', '4e076f0908', 'Get BCH Now Kid', 'Markets & memes', 'A boy in a green GET BCH. NOW shirt holds a coffee cup and looks skeptical.'],
  ['just-do-it-in-bch', 'e47e24fd12', 'Just BCH It', 'Priced in BCH', 'A colorful sneaker with a green price tag reading 0.48 BCH.'],
  ['know-your-chains', 'd038201fe2', 'Know Your Chains', 'Banks & power', 'A poster reading KYC Know Your Chains above six people chained together at the wrists.'],
  ['let-the-kid-play', '65a73c0d7a', 'Let the Kid Play', 'Privacy', 'Stencil of a boy kicking a football while three drones hover above.'],
  ['some-money-is-more-equal', 'a5fed29a3d', 'Some Money Is More Equal', 'Banks & power', 'Silhouettes of pigs turning into men in suits and walking away from a farm.'],
  ['your-shopping-your-permanent-record', '07ff61755c', 'Your Shopping, Your Permanent Record', 'Privacy', 'A woman pays by card at a supermarket checkout surrounded by security cameras.'],
];

export function setupMediaSlideshow($) {
  const gallery = $('media-gallery');
  const cards = [...$('media-strip').querySelectorAll('.media-slide')].map((card) => ({
    image: card.querySelector('img'),
    unavailable: card.querySelector('.media-unavailable'),
    link: card.querySelector('a'),
    title: card.querySelector('strong'),
    category: card.querySelector('.media-caption span'),
  }));
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let index = 0;
  let visible = !('IntersectionObserver' in window);
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
    observer.observe(gallery);
  }

  function show(card, slide) {
    const { image, unavailable, link, title, category } = card;
    const [slug, hash, name, topic, alt] = slide;
    image.hidden = false;
    image.style.opacity = '0';
    unavailable.hidden = true;
    image.alt = alt;
    image.src = `${MEDIA_BASE}${slug}/${hash}/thumb.webp`;
    link.href = `https://bch.now/media/${slug}`;
    title.textContent = name;
    category.textContent = topic;
  }

  cards.forEach(({ image, unavailable }) => {
    const failed = () => {
      image.hidden = true;
      unavailable.hidden = false;
    };
    image.addEventListener('error', failed);
    image.addEventListener('load', () => { image.style.opacity = '1'; });
    if (image.complete && !image.naturalWidth) failed();
  });
  setInterval(() => {
    if (!visible || motion.matches || document.hidden || gallery.matches(':hover') || gallery.contains(document.activeElement)) return;
    index = (index + 1) % slides.length;
    cards.forEach((card, offset) => show(card, slides[(index + offset) % slides.length]));
  }, 6000);
}
