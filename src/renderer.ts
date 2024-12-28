import puppeteer, { ScreenshotOptions } from 'puppeteer';
import url from 'url';
import { dirname } from 'path';

import { Config } from './config';

type SerializedResponse = {
  status: number;
  customHeaders: Map<string, string>;
  content: string;
};

type ViewportDimensions = {
  width: number;
  height: number;
};

const MOBILE_USERAGENT =
  'Mozilla/5.0 (Linux; Android 8.0.0; Pixel 2 XL Build/OPD1.170816.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.75 Mobile Safari/537.36';

/**
 * Wraps Puppeteer's interface to Headless Chrome to expose high-level rendering
 * APIs that are able to handle web components and PWAs.
 */
export class Renderer {
  private browser: puppeteer.Browser;
  private config: Config;

  constructor(browser: puppeteer.Browser, config: Config) {
    this.browser = browser;
    this.config = config;
  }

  private restrictRequest(requestUrl: string): boolean {
    const parsedUrl = url.parse(requestUrl);

    if (parsedUrl.hostname && parsedUrl.hostname.match(/\.internal$/)) {
      return true;
    }

    if (this.config.restrictedUrlPattern && requestUrl.match(new RegExp(this.config.restrictedUrlPattern))) {
      return true;
    }

    return false;
  }

  async serialize(
    requestUrl: string,
    isMobile: boolean,
    timezoneId?: string
  ): Promise<SerializedResponse> {
    /**
     * Executed on the page after the page has loaded. Strips script and
     * import tags to prevent further loading of resources.
     */
    function stripPage() {
      // Strip only script tags that contain JavaScript (either no type attribute or one that contains "javascript")
      const elements = document.querySelectorAll(
        'script:not([type]), script[type*="javascript"], script[type="module"], link[rel=import]'
      );
      for (const e of Array.from(elements)) {
        e.remove();
      }
    }

    /**
     * Injects a <base> tag which allows other resources to load. This
     * has no effect on serialised output, but allows it to verify render
     * quality.
     */
    function injectBaseHref(origin: string, directory: string) {
      const bases = document.head.querySelectorAll('base');
      if (bases.length) {
        // Patch existing <base> if it is relative.
        const existingBase = bases[0].getAttribute('href') || '';
        if (existingBase.startsWith('/')) {
          // check if is only "/" if so add the origin only
          if (existingBase === '/') {
            bases[0].setAttribute('href', origin);
          } else {
            bases[0].setAttribute('href', origin + existingBase);
          }
        }
      } else {
        // Only inject <base> if it doesn't already exist.
        const base = document.createElement('base');
        // Base url is the current directory
        base.setAttribute('href', origin + directory);
        document.head.insertAdjacentElement('afterbegin', base);
      }
    }

    const page = await this.browser.newPage();

    // Page may reload when setting isMobile
    // https://github.com/GoogleChrome/puppeteer/blob/v1.10.0/docs/api.md#pagesetviewportviewport
    await page.setViewport({
      width: this.config.width,
      height: this.config.height,
      isMobile,
    });

    if (isMobile) {
      page.setUserAgent(MOBILE_USERAGENT);
    }

    if (timezoneId) {
      try {
        await page.emulateTimezone(timezoneId);
      } catch (e:any) {
        if (e.message.includes('Invalid timezone')) {
          return {
            status: 400,
            customHeaders: new Map(),
            content: 'Invalid timezone id',
          };
        }
      }
    }

    await page.setExtraHTTPHeaders(this.config.reqHeaders);

    page.evaluateOnNewDocument('customElements.forcePolyfill = true');
    page.evaluateOnNewDocument('ShadyDOM = {force: true}');
    page.evaluateOnNewDocument('ShadyCSS = {shimcssproperties: true}');

    await page.setRequestInterception(true);

    page.on('request', (interceptedRequest: puppeteer.HTTPRequest) => {
      if (this.restrictRequest(interceptedRequest.url())) {
        interceptedRequest.abort();
      } else {
        interceptedRequest.continue();
      }
    });

    let response: puppeteer.HTTPResponse | null = null;

    try {
      // Navigate to page. Wait until there are no outstanding network requests.
      response = await page.goto(requestUrl, {
        timeout: this.config.timeout,
        waitUntil: 'networkidle0',
      });

      // Wait for the page to indicate it's ready by checking window.rendertronReady
      await page.waitForFunction('window.rendertronReady === true', {
        timeout: 100000, // Wait for 60 seconds max
      });

    } catch (e) {
      console.error(e);
    }

    if (!response) {
      console.error('response does not exist');
      // This should only occur when the page is about:blank. See
      // https://github.com/GoogleChrome/puppeteer/blob/v1.5.0/docs/api.md#pagegotourl-options.
      await page.close();
      if (this.config.closeBrowser) {
        await this.browser.close();
      }
      return { status: 400, customHeaders: new Map(), content: '' };
    }

    // Disable access to compute metadata. See
    // https://cloud.google.com/compute/docs/storing-retrieving-metadata.
    if (response.headers()['metadata-flavor'] === 'Google') {
      await page.close();
      if (this.config.closeBrowser) {
        await this.browser.close();
      }
      return { status: 403, customHeaders: new Map(), content: '' };
    }

    // Set status to the initial server's response code. Check for a <meta
    // name="render:status_code" content="4xx" /> tag which overrides the status
    // code.
    let statusCode = response.status();
    const newStatusCode = await page
      .$eval('meta[name="render:status_code"]', (element) =>
        parseInt(element.getAttribute('content') || ''))
      .catch(() => undefined);

    if (statusCode === 304) {
      statusCode = 200;
    }

    if (statusCode === 200 && newStatusCode) {
      statusCode = newStatusCode;
    }

    const customHeaders = await page
      .$eval('meta[name="render:header"]', (element) => {
        const result = new Map<string, string>();
        const header = element.getAttribute('content');
        if (header) {
          const i = header.indexOf(':');
          if (i !== -1) {
            result.set(
              header.substr(0, i).trim(),
              header.substring(i + 1).trim()
            );
          }
        }
        return JSON.stringify([...result]);
      })
      .catch(() => undefined);

    // Remove script & import tags.
    await page.evaluate(stripPage);

    // Inject <base> tag with the origin of the request (i.e., no path).
    const parsedUrl = url.parse(requestUrl);
    await page.evaluate(
      injectBaseHref,
      `${parsedUrl.protocol}//${parsedUrl.host}`,
      `${dirname(parsedUrl.pathname || '')}`
    );

    // Serialize page.
    const result = (await page.content()) as string;

    await page.close();
    if (this.config.closeBrowser) {
      await this.browser.close();
    }
    return {
      status: statusCode,
      customHeaders: customHeaders
        ? new Map(JSON.parse(customHeaders))
        : new Map(),
      content: result,
    };
  }


  async screenshot(
    url: string,
    isMobile: boolean,
    dimensions: ViewportDimensions,
    options?: ScreenshotOptions,
    timezoneId?: string
  ): Promise<Buffer> {
    const page = await this.browser.newPage();
  
    await page.setViewport({
      width: dimensions.width,
      height: dimensions.height,
      isMobile,
    });
  
    if (isMobile) {
      page.setUserAgent(MOBILE_USERAGENT);
    }
  
    await page.setRequestInterception(true);
  
    page.addListener('request', (interceptedRequest: puppeteer.HTTPRequest) => {
      if (this.restrictRequest(interceptedRequest.url())) {
        interceptedRequest.abort();
      } else {
        interceptedRequest.continue();
      }
    });
  
    if (timezoneId) {
      await page.emulateTimezone(timezoneId);
    }
  
    let response: puppeteer.HTTPResponse | null = null;
  
    try {
      response = await page.goto(url, {
        timeout: this.config.timeout,
        waitUntil: 'networkidle0',
      });
  
      // Wait for the page to be ready
      await page.waitForFunction('window.rendertronReady === true', {
        timeout: 100000, // Wait up to 60 seconds
      });
    } catch (e) {
      console.error(e);
    }
  
    if (!response) {
      await page.close();
      if (this.config.closeBrowser) {
        await this.browser.close();
      }
      throw new Error('NoResponse');
    }
  
    if (response.headers()['metadata-flavor'] === 'Google') {
      await page.close();
      if (this.config.closeBrowser) {
        await this.browser.close();
      }
      throw new Error('Forbidden');
    }
  
    const screenshot = await page.screenshot(options);
  
    if (!(screenshot instanceof Buffer)) {
      throw new Error('ScreenshotFailed');
    }
  
    await page.close();
    if (this.config.closeBrowser) {
      await this.browser.close();
    }
    return screenshot;
  }
}
