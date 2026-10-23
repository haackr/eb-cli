import type * as _puppeteer from 'puppeteer';

declare global {
  namespace puppeteer {
    export type Browser = _puppeteer.Browser;
    export type BrowserContext = _puppeteer.BrowserContext;
    export type Page = _puppeteer.Page;
    export type Cookie = _puppeteer.Cookie;
    export type ElementHandle<T extends Node = Element> = _puppeteer.ElementHandle<T>;
    export type LaunchOptions = _puppeteer.LaunchOptions;
    export type Frame = _puppeteer.Frame;
    export type Target = _puppeteer.Target;
  }
}
