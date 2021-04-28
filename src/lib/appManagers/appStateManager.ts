/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import type { Dialog } from './appMessagesManager';
import type { UserAuth } from '../mtproto/mtproto_config';
import type { AppUsersManager } from './appUsersManager';
import type { AppChatsManager } from './appChatsManager';
import type { AuthState } from '../../types';
import type FiltersStorage from '../storages/filters';
import type DialogsStorage from '../storages/dialogs';
import type { AppDraftsManager } from './appDraftsManager';
import EventListenerBase from '../../helpers/eventListenerBase';
import rootScope from '../rootScope';
import sessionStorage from '../sessionStorage';
import { logger } from '../logger';
import { copy, setDeepProperty, validateInitObject } from '../../helpers/object';
import { getHeavyAnimationPromise } from '../../hooks/useHeavyAnimationCheck';
import App from '../../config/app';
import DEBUG, { MOUNT_CLASS_TO } from '../../config/debug';

const REFRESH_EVERY = 24 * 60 * 60 * 1000; // 1 day
const STATE_VERSION = App.version;

export type Background = {
  type: 'color' | 'image' | 'default',
  blur: boolean,
  highlightningColor?: string,
  color?: string,
  slug?: string,
};

export type Theme = {
  name: 'day' | 'night',
  background: Background
};

export type State = Partial<{
  dialogs: Dialog[],
  allDialogsLoaded: DialogsStorage['allDialogsLoaded'],
  chats: {[peerId: string]: ReturnType<AppChatsManager['getChat']>},
  users: {[peerId: string]: ReturnType<AppUsersManager['getUser']>},
  messages: any[],
  contactsList: number[],
  updates: Partial<{
    seq: number,
    pts: number,
    date: number
  }>,
  filters: FiltersStorage['filters'],
  maxSeenMsgId: number,
  stateCreatedTime: number,
  recentEmoji: string[],
  topPeers: number[],
  recentSearch: number[],
  version: typeof STATE_VERSION,
  authState: AuthState,
  hiddenPinnedMessages: {[peerId: string]: number},
  settings: {
    messagesTextSize: number,
    sendShortcut: 'enter' | 'ctrlEnter',
    animationsEnabled: boolean,
    autoDownload: {
      contacts: boolean
      private: boolean
      groups: boolean
      channels: boolean
    },
    autoPlay: {
      gifs: boolean,
      videos: boolean
    },
    stickers: {
      suggest: boolean,
      loop: boolean
    },
    background?: Background, // ! DEPRECATED
    themes: Theme[],
    theme: Theme['name'],
    notifications: {
      sound: boolean
    },
    nightTheme?: boolean, // ! DEPRECATED
  },
  keepSigned: boolean,
  drafts: AppDraftsManager['drafts']
}>;

export const STATE_INIT: State = {
  dialogs: [],
  allDialogsLoaded: {},
  chats: {},
  users: {},
  messages: [],
  contactsList: [],
  updates: {},
  filters: {},
  maxSeenMsgId: 0,
  stateCreatedTime: Date.now(),
  recentEmoji: [],
  topPeers: [],
  recentSearch: [],
  version: STATE_VERSION,
  authState: {
    _: 'authStateSignIn'
  },
  hiddenPinnedMessages: {},
  settings: {
    messagesTextSize: 16,
    sendShortcut: 'enter',
    animationsEnabled: true,
    autoDownload: {
      contacts: true,
      private: true,
      groups: true,
      channels: true
    },
    autoPlay: {
      gifs: true,
      videos: true
    },
    stickers: {
      suggest: true,
      loop: true
    },
    themes: [{
      name: 'day',
      background: {
        type: 'image',
        blur: false,
        slug: 'ByxGo2lrMFAIAAAAmkJxZabh8eM', // * new blurred camomile,
        highlightningColor: 'hsla(85.5319, 36.9171%, 40.402%, 0.4)'
      }
    }, {
      name: 'night',
      background: {
        type: 'color',
        blur: false,
        color: '#0f0f0f',
        highlightningColor: 'hsla(0, 0%, 3.82353%, 0.4)'
      }
    }],
    theme: 'day',
    notifications: {
      sound: false
    }
  },
  keepSigned: true,
  drafts: {}
};

const ALL_KEYS = Object.keys(STATE_INIT) as any as Array<keyof State>;

const REFRESH_KEYS = ['dialogs', 'allDialogsLoaded', 'messages', 'contactsList', 'stateCreatedTime',
  'updates', 'maxSeenMsgId', 'filters', 'topPeers'] as any as Array<keyof State>;

export class AppStateManager extends EventListenerBase<{
  save: (state: State) => Promise<void>,
  peerNeeded: (peerId: number) => void,
  peerUnneeded: (peerId: number) => void,
}> {
  public static STATE_INIT = STATE_INIT;
  private loaded: Promise<State>;
  private loadPromises: Promise<any>[] = [];
  private loadAllPromise: Promise<any>;
  private log = logger('STATE'/* , LogLevels.error */);

  private state: State;

  private neededPeers: Map<number, Set<string>> = new Map();
  private singlePeerMap: Map<string, number> = new Map();

  constructor() {
    super();
    this.loadSavedState();
  }

  public loadSavedState(): Promise<State> {
    if(this.loadAllPromise) return this.loadAllPromise;
    //console.time('load state');
    this.loaded = new Promise((resolve) => {
      Promise.all(ALL_KEYS.concat('user_auth' as any).map(key => sessionStorage.get(key))).then((arr) => {
        let state: State = {};

        // ! then can't store false values
        ALL_KEYS.forEach((key, idx) => {
          const value = arr[idx];
          if(value !== undefined) {
            // @ts-ignore
            state[key] = value;
          } else {
            // @ts-ignore
            state[key] = copy(STATE_INIT[key]);
          }
        });

        const time = Date.now();
        /* if(state.version !== STATE_VERSION) {
          state = copy(STATE_INIT);
        } else  */if((state.stateCreatedTime + REFRESH_EVERY) < time/*  || true *//*  && false */) {
          if(DEBUG) {
            this.log('will refresh state', state.stateCreatedTime, time);
          }
          
          REFRESH_KEYS.forEach(key => {
            // @ts-ignore
            state[key] = copy(STATE_INIT[key]);
          });

          const users: typeof state['users'] = {}, chats: typeof state['chats'] = {};
          if(state.recentSearch?.length) {
            state.recentSearch.forEach(peerId => {
              if(peerId < 0) chats[peerId] = state.chats[peerId];
              else users[peerId] = state.users[peerId];
            });
          }

          state.users = users;
          state.chats = chats;
        }

        if(!state.settings.hasOwnProperty('themes') && state.settings.background) {
          const theme = STATE_INIT.settings.themes.find(t => t.name === STATE_INIT.settings.theme);
          if(theme) {
            theme.background = copy(state.settings.background);
          }
        }

        if(!state.settings.hasOwnProperty('theme') && state.settings.hasOwnProperty('nightTheme')) {
          state.settings.theme = state.settings.nightTheme ? 'night' : 'day';
        }

        validateInitObject(STATE_INIT, state);

        this.state = state;
        this.state.version = STATE_VERSION;

        // ! probably there is better place for it
        rootScope.settings = this.state.settings;

        if(DEBUG) {
          this.log('state res', state, copy(state));
        }
        
        //return resolve();

        const auth: UserAuth = arr[arr.length - 1] as any;
        if(auth) {
          // ! Warning ! DON'T delete this
          this.state.authState = {_: 'authStateSignedIn'};
          rootScope.broadcast('user_auth', typeof(auth) !== 'number' ? (auth as any).id : auth); // * support old version
        }
        
        //console.timeEnd('load state');
        resolve(this.state);
      }).catch(resolve);
    });

    return this.addLoadPromise(this.loaded);
  }

  public addLoadPromise(promise: Promise<any>) {
    if(!this.loaded) {
      return this.loadSavedState();
    }

    this.loadPromises.push(promise);
    return this.loadAllPromise = Promise.all(this.loadPromises)
    .then(() => this.state, () => this.state);
  }

  public getState() {
    return this.state === undefined ? this.loadSavedState() : Promise.resolve(this.state);
  }

  public setByKey(key: string, value: any) {
    setDeepProperty(this.state, key, value);
    rootScope.broadcast('settings_updated', {key, value});

    const first = key.split('.')[0];
    // @ts-ignore
    this.pushToState(first, this.state[first]);
  }

  public pushToState<T extends keyof State>(key: T, value: State[T]) {
    this.state[key] = value;

    sessionStorage.set({
      [key]: value
    });
  }

  public setPeer(peerId: number, peer: any) {
    const container = peerId > 0 ? this.state.users : this.state.chats;
    if(container.hasOwnProperty(peerId)) return;
    container[peerId] = peer;
  }

  public requestPeer(peerId: number, type: string, limit?: number) {
    let set = this.neededPeers.get(peerId);
    if(set && set.has(type)) {
      return;
    }

    if(!set) {
      set = new Set();
      this.neededPeers.set(peerId, set);
    }

    set.add(type);
    this.dispatchEvent('peerNeeded', peerId);

    if(limit !== undefined) {
      this.keepPeerSingle(peerId, type);
    }
  }

  public isPeerNeeded(peerId: number) {
    return this.neededPeers.has(peerId);
  }

  public keepPeerSingle(peerId: number, type: string) {
    const existsPeerId = this.singlePeerMap.get(type);
    if(existsPeerId && existsPeerId !== peerId) {
      const set = this.neededPeers.get(existsPeerId);
      set.delete(type);

      if(!set.size) {
        this.neededPeers.delete(existsPeerId);
        this.dispatchEvent('peerUnneeded', existsPeerId);
      }
    }

    this.singlePeerMap.set(type, peerId);
  }

  /* public resetState() {
    for(let i in this.state) {
      // @ts-ignore
      this.state[i] = false;
    }
    sessionStorage.set(this.state).then(() => {
      location.reload();
    });
  } */
}

//console.trace('appStateManager include');

const appStateManager = new AppStateManager();
MOUNT_CLASS_TO.appStateManager = appStateManager;
export default appStateManager;