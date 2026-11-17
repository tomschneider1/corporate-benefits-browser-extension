import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

import {
  brandToken,
  hostnameOf,
  nameMatchesToken,
  registrableDomain,
} from '../extension/src/lib/domain.js';
import {
  isLoginPage,
  parseCategories,
  parseOfferList,
  parseOfferPage,
} from '../extension/src/lib/parse.js';

function docFromHtml(html) {
  return parseHTML(html).document;
}

test('domain helpers normalise shop hostnames and match offer names', () => {
  assert.equal(registrableDomain('www.11teamsports.com'), '11teamsports.com');
  assert.equal(registrableDomain('checkout.shop.zalando.de'), 'zalando.de');
  assert.equal(registrableDomain('store.adidas.co.uk'), 'adidas.co.uk');
  assert.equal(brandToken('www.11teamsports.com'), '11teamsports');
  assert.equal(
    hostnameOf('https://www.adidas.de/own_your_football_pack'),
    'www.adidas.de',
  );

  assert.equal(nameMatchesToken('11teamsports', '11teamsports'), true);
  assert.equal(nameMatchesToken('adidas', 'adidas'), true);
  assert.equal(nameMatchesToken('LG Electronics Germany - Oktober-Special', 'lg'), true);
  assert.equal(nameMatchesToken('Louis Poulsen', 'louispoulsen'), true);
  assert.equal(nameMatchesToken('adidas', 'zalando'), false);
});

test('isLoginPage distinguishes public login HTML from authenticated pages', () => {
  const loginDoc = docFromHtml(`
    <!doctype html>
    <html>
      <body>
        <form action="/login" method="POST">
          <input id="loginData[email]" type="email" />
          <input id="loginData[password]" type="password" />
          <button id="cbg3-submit-login" type="submit">Anmelden</button>
        </form>
      </body>
    </html>
  `);
  assert.equal(isLoginPage(loginDoc), true);

  const authDoc = docFromHtml(`
    <!doctype html>
    <html>
      <body>
        <nav><a href="/overview/21">Auto</a><a href="/logout">Logout</a></nav>
        <main id="main-content"></main>
      </body>
    </html>
  `);
  assert.equal(isLoginPage(authDoc), false);
});

test('parseCategories extracts unique top-level categories and ignores anchor sub-links', () => {
  const doc = docFromHtml(`
    <!doctype html>
    <html>
      <body>
        <nav>
          <a href="/overview/21">Auto</a>
          <a href="/overview/21#24">Autoservice &amp; Autoteile</a>
          <a href="/overview/35">Mode</a>
          <a href="/overview/35">Mode (Duplikat)</a>
          <a href="/overview/1740">Sport</a>
        </nav>
      </body>
    </html>
  `);
  const categories = parseCategories(doc);
  assert.deepEqual(categories, [
    { id: '21', name: 'Auto', path: '/overview/21' },
    { id: '35', name: 'Mode', path: '/overview/35' },
    { id: '1740', name: 'Sport', path: '/overview/1740' },
  ]);
});

test('parseOfferList extracts offer cards with discount, teaser and category id', () => {
  const doc = docFromHtml(`
    <main id="main-content">
      <div class="cbg3-list-item" data-id="101" data-zipcode="">
        <div class="row cbg3-list-item--container">
          <div class="cbg3-offer-list-item--rest-days"><p>1 Tag!</p></div>
          <div class="cbg3-offer-list-item--content">
            <a href="/offer/101/cat/24" title="Zum Angebot: Beispielshop - Zubehöraktion">
              <h3>Beispielshop - Zubehöraktion<span> - </span></h3>
            </a>
            <p class="cbg3-list-item--copy">Sparen Sie auf ausgewähltes Zubehör &amp; Ersatzteile.</p>
            <div class="cbg3-list-item--discount">
              <p><span class="cbg3-discount-and-location--uppercase">25% Rabatt</span></p>
            </div>
          </div>
        </div>
      </div>
    </main>
  `);
  const offers = parseOfferList(doc);
  assert.equal(offers.length, 1);
  assert.deepEqual(offers[0], {
    id: '101',
    cat: '24',
    path: '/offer/101/cat/24',
    name: 'Beispielshop - Zubehöraktion',
    teaser: 'Sparen Sie auf ausgewähltes Zubehör & Ersatzteile.',
    discount: '25% Rabatt',
    restDays: '1 Tag!',
    breadcrumb: null,
    local: false,
  });
});

test('parseOfferPage handles multi-variant code offers, PDF store vouchers and link-only offers', () => {
  const sportsDoc = docFromHtml(`
    <main id="main-content">
      <h1>Beispiel-Sportshop</h1>
      <div class="cbg3-text-claim"><h3>Sportartikel und Zubehör</h3></div>
      <div class="cbg3-discount-and-location">km &lt; 20% Rabatt</div>
      <div id="saleoptions" class="cbg3-salesoption">
        <div class="cbg3-salesoption--item" data-so-id="201">
          <h3><strong>Online</strong></h3>
          <p>Fordern Sie hier Ihren persönlichen Gutscheincode an.</p>
          <div class="cbg3-salesoption--request">
            <div class="cbg3-salesoption--code" data-request-id="code-201"></div>
          </div>
          <div class="cbg3-button--standard">
            <button
              class="cbg3-code-request"
              data-url="/api/coupon?ac=1000000000"
              data-offerid="102"
              data-salesoptionid="201"
            >
              <span>Jetzt Gutschein abrufen</span>
            </button>
          </div>
          <div class="cbg3-button--standard">
            <button data-href="https://sportshop.example/sortiment">
              <span>Zum Onlineshop</span>
            </button>
          </div>
        </div>

        <div class="cbg3-salesoption--item" data-so-id="202">
          <h3><strong>Online-Rabatt auf ausgewählte Trikots</strong></h3>
          <p>Rabatt auf ausgewählte Trikots.</p>
          <div class="cbg3-button--standard">
            <button
              class="cbg3-code-request"
              data-url="/api/coupon?ac=1000000000"
              data-offerid="102"
              data-salesoptionid="202"
            >
              <span>Jetzt Gutschein abrufen</span>
            </button>
          </div>
          <div class="cbg3-button--standard">
            <button data-href="https://sportshop.example/trikots">
              <span>Zum Onlineshop</span>
            </button>
          </div>
        </div>

        <div class="cbg3-salesoption--item" data-so-id="203">
          <h3><strong>Filialgutschein (PDF)</strong></h3>
          <p>Gültig in ausgewählten Stores.</p>
          <div class="cbg3-button--standard">
            <a href="/download/102/203">Download</a>
          </div>
        </div>

        <div class="cbg3-salesoption--item" data-so-id="204">
          <h3><strong>Hinweis</strong></h3>
          <p>Bei Rückfragen steht Ihnen das Team telefonisch zur Verfügung.</p>
        </div>
      </div>
    </main>
  `);

  const sports = parseOfferPage(sportsDoc, '102');
  assert.equal(sports.title, 'Beispiel-Sportshop');
  assert.equal(sports.discount, '< 20% Rabatt');
  assert.equal(sports.saleOptions.length, 4);

  const codeOptions = sports.saleOptions.filter((s) => s.type === 'code');
  assert.equal(codeOptions.length, 2);
  assert.deepEqual(codeOptions[0].codeRequest, {
    url: '/api/coupon?ac=1000000000',
    offerId: '102',
    saleOptionId: '201',
  });
  assert.equal(codeOptions[0].shopUrl, 'https://sportshop.example/sortiment');
  assert.equal(codeOptions[1].title, 'Online-Rabatt auf ausgewählte Trikots');
  assert.equal(codeOptions[1].shopUrl, 'https://sportshop.example/trikots');

  const pdfOption = sports.saleOptions.find((s) => s.type === 'pdf');
  assert.ok(pdfOption);
  assert.equal(pdfOption.downloadPath, '/download/102/203');

  const linkOnlyDoc = docFromHtml(`
    <main id="main-content">
      <h1>Beispiel-Elektronikshop</h1>
      <div class="cbg3-discount-and-location">&lt; 15% Rabatt</div>
      <div class="cbg3-salesoption--item" data-so-id="205">
        <h3>Online</h3>
        <p>Die Nachlässe wurden bereits im Partnerstore berücksichtigt.</p>
        <div class="cbg3-button--standard">
          <button data-href="https://elektronik.example/partner?region=de&amp;code=DEMO-NICHT-GUELTIG">
            <span>Zum Onlineshop</span>
          </button>
        </div>
      </div>
    </main>
  `);
  const electronics = parseOfferPage(linkOnlyDoc, '103');
  assert.equal(electronics.saleOptions.length, 1);
  assert.equal(electronics.saleOptions[0].type, 'link');
  assert.equal(
    electronics.saleOptions[0].shopUrl,
    'https://elektronik.example/partner?region=de&code=DEMO-NICHT-GUELTIG',
  );
});
