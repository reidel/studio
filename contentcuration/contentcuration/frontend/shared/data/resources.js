import Dexie from 'dexie';
import findIndex from 'lodash/findIndex';
import flatMap from 'lodash/flatMap';
import isArray from 'lodash/isArray';
import isFunction from 'lodash/isFunction';
import matches from 'lodash/matches';
import overEvery from 'lodash/overEvery';
import pick from 'lodash/pick';
import uniq from 'lodash/uniq';

import uuidv4 from 'uuid/v4';
import channel from './broadcastChannel';
import {
  CHANGE_TYPES,
  CHANGES_TABLE,
  IGNORED_SOURCE,
  MESSAGES,
  RELATIVE_TREE_POSITIONS,
  STATUS,
  TABLE_NAMES,
} from './constants';
import applyChanges, { collectChanges } from './applyRemoteChanges';
import mergeAllChanges from './mergeChanges';
import db, { CLIENTID, Collection } from './db';
import { API_RESOURCES, INDEXEDDB_RESOURCES } from './registry';
import { NEW_OBJECT } from 'shared/constants';
import client from 'shared/client';
import { constantStrings } from 'shared/mixins';
import { promiseChunk } from 'shared/utils';

// Number of seconds after which data is considered stale.
const REFRESH_INTERVAL = 60;

const LAST_FETCHED = '__last_fetch';

const QUERY_SUFFIXES = {
  IN: 'in',
  GT: 'gt',
  GTE: 'gte',
  LT: 'lt',
  LTE: 'lte',
};

const VALID_SUFFIXES = new Set(Object.values(QUERY_SUFFIXES));

const SUFFIX_SEPERATOR = '__';
const validPositions = new Set(Object.values(RELATIVE_TREE_POSITIONS));

// Custom uuid4 function to match our dashless uuids on the server side
export function uuid4() {
  return uuidv4().replace(/-/g, '');
}

/**
 * @param {Function|Object} updater
 * @return {Function}
 */
export function resolveUpdater(updater) {
  return isFunction(updater) ? updater : () => updater;
}

/*
 * Code to allow multiple inheritance in JS
 * modified from https://hacks.mozilla.org/2015/08/es6-in-depth-subclassing/
 */

function mix(...mixins) {
  // Inherit from the last class to allow constructor inheritance
  class Mix extends mixins.slice(-1)[0] {}

  // Programmatically add all the methods and accessors
  // of the mixins to class Mix.
  for (let mixin of mixins) {
    copyProperties(Mix, mixin);
    copyProperties(Mix.prototype, mixin.prototype);
  }
  return Mix;
}

function copyProperties(target, source) {
  for (let key of Reflect.ownKeys(source)) {
    if (key !== 'constructor' && key !== 'prototype' && key !== 'name') {
      let desc = Object.getOwnPropertyDescriptor(source, key);
      Object.defineProperty(target, key, desc);
    }
  }
}

function objectsAreStale(objs) {
  const now = Date.now();
  return objs.some(obj => {
    const refresh = obj[LAST_FETCHED] + REFRESH_INTERVAL * 1000;
    return refresh < now;
  });
}

class APIResource {
  constructor({ urlName, ...options }) {
    this.urlName = urlName;
    copyProperties(this, options);
    API_RESOURCES[urlName] = this;
  }

  getUrlFunction(endpoint) {
    return window.Urls[`${this.urlName}_${endpoint}`];
  }

  modelUrl(id) {
    // Leveraging Django REST Framework generated URL patterns.
    return this.getUrlFunction('detail')(id);
  }

  collectionUrl() {
    // Leveraging Django REST Framework generated URL patterns.
    return this.getUrlFunction('list')();
  }

  fetchModel(id) {
    return client.get(this.modelUrl(id));
  }

  fetchCollection(params) {
    return client.get(this.collectionUrl(), { params });
  }

  makeRequest(request) {
    return new Promise((resolve, reject) => {
      const messageId = uuidv4();
      function handler(msg) {
        if (msg.messageId === messageId && msg.type === MESSAGES.REQUEST_RESPONSE) {
          channel.removeEventListener('message', handler);
          if (msg.status === STATUS.SUCCESS) {
            return resolve(msg.data);
          } else if (msg.status === STATUS.FAILURE && msg.err) {
            return reject(msg.err);
          }
          // Otherwise something unspecified happened
          return reject();
        }
      }
      channel.addEventListener('message', handler);
      channel.postMessage({
        ...request,
        urlName: this.urlName,
        messageId,
      });
    });
  }

  requestModel(id) {
    return this.makeRequest({
      type: MESSAGES.FETCH_MODEL,
      id,
    });
  }

  requestCollection(params) {
    return this.makeRequest({
      type: MESSAGES.FETCH_COLLECTION,
      params,
    });
  }
}

class IndexedDBResource {
  constructor({
    tableName,
    idField = 'id',
    uuid = true,
    indexFields = [],
    annotatedFilters = [],
    ...options
  } = {}) {
    this.tableName = tableName;
    this.uuid = uuid;
    this.schema = [idField, ...indexFields].join(',');
    const nonCompoundFields = indexFields.filter(f => f.split('+').length === 1);
    this.indexFields = new Set([idField, ...nonCompoundFields]);
    // A list of property names that if we filter by them, we will stamp them on
    // the data returned from the API endpoint, so that we can requery them again
    // via indexedDB.
    this.annotatedFilters = annotatedFilters;

    INDEXEDDB_RESOURCES[tableName] = this;
    copyProperties(this, options);
    this.syncable = false;
    // By default these resources do not sync changes to the backend.
    // Any syncing behaviour should be implemented through specialized events.
  }

  get table() {
    return db[this.tableName];
  }

  get idField() {
    return this.table.schema.primKey.keyPath;
  }

  /*
   * Transaction method used to invoke updates, creates and deletes
   * in a way that doesn't trigger listeners from the client that
   * initiated it by setting the CLIENTID.
   */
  transaction(mode, ...extraTables) {
    const callback = extraTables.pop(-1);
    return db.transaction(mode, this.tableName, ...extraTables, () => {
      Dexie.currentTransaction.source = CLIENTID;
      return callback();
    });
  }

  where(params = {}) {
    const table = db[this.tableName];
    // Indexed parameters
    const whereParams = {};
    // Non-indexed parameters
    const filterParams = {};
    // Array parameters - ones that are filtering by 'in'
    const arrayParams = {};
    // Suffixed parameters - ones that are filtering by [gt/lt](e)
    const suffixedParams = {};
    for (let key of Object.keys(params)) {
      // Partition our parameters
      const [rootParam, suffix] = key.split(SUFFIX_SEPERATOR);
      if (suffix && VALID_SUFFIXES.has(suffix) && suffix !== QUERY_SUFFIXES.IN) {
        // We have a suffix and it is for an operation that isn't IN
        suffixedParams[rootParam] = suffixedParams[rootParam] || {};
        suffixedParams[rootParam][suffix] = params[key];
      } else if (this.indexFields.has(rootParam)) {
        if (suffix === QUERY_SUFFIXES.IN) {
          // We have a suffix for an IN operation
          arrayParams[rootParam] = params[key];
        } else if (!suffix) {
          whereParams[rootParam] = params[key];
        }
      } else {
        filterParams[rootParam] = params[key];
      }
    }
    let collection;
    if (Object.keys(arrayParams).length !== 0) {
      if (Object.keys(arrayParams).length === 1) {
        collection = table.where(Object.keys(arrayParams)[0]).anyOf(Object.values(arrayParams)[0]);
        if (process.env.NODE_ENV !== 'production') {
          // Flag a warning if we tried to filter by an Array and other where params
          /* eslint-disable no-console */
          if (Object.keys(whereParams).length > 1) {
            console.warning(
              `Tried to query ${Object.keys(whereParams).join(
                ', '
              )} alongside array parameters which is not currently supported`
            );
          }
        }
        Object.assign(filterParams, whereParams);
      } else if (Object.keys(arrayParams).length > 1) {
        if (process.env.NODE_ENV !== 'production') {
          // Flag a warning if we tried to filter by an Array and other where params
          /* eslint-disable no-console */
          console.warning(
            `Tried to query multiple __in params ${Object.keys(arrayParams).join(
              ', '
            )} which is not currently supported`
          );
        }
      }
    } else if (Object.keys(whereParams).length > 0) {
      collection = table.where(whereParams);
    } else {
      collection = table.toCollection();
    }
    let filterFn;
    if (Object.keys(filterParams).length !== 0) {
      filterFn = matches(filterParams);
    }
    if (Object.keys(suffixedParams).length !== 0) {
      // Reassign the filterFn to be a combination of all the suffixed parameter filters
      // we are applying here, so require that the item passes all the operations
      // hence, overEvery.
      filterFn = overEvery(
        [
          // First generate a flat array of all suffix parameter filter functions
          ...flatMap(
            Object.keys(suffixedParams),
            // First we iterate over the specific parameters we are filtering over
            key => {
              // Then we iterate over the suffixes that we are filtering over
              return Object.keys(suffixedParams[key]).map(suffix => {
                // For each suffix, we have a specific value
                const value = suffixedParams[key][suffix];
                // Now return a filter function depending on the specific
                // suffix that we have passed.
                if (suffix === QUERY_SUFFIXES.LT) {
                  return item => item[key] < value;
                } else if (suffix === QUERY_SUFFIXES.LTE) {
                  return item => item[key] <= value;
                } else if (suffix === QUERY_SUFFIXES.GT) {
                  return item => item[key] > value;
                } else if (suffix === QUERY_SUFFIXES.GTE) {
                  return item => item[key] >= value;
                }
                // Because of how we are initially generating these
                // we should never get to here and returning undefined
              });
            }
          ),
          // If there are filter Params, this will be defined
          filterFn,
          // If there were not, it will be undefined and filtered by the final filter
          // In addition, in the unlikely case that the suffix was not recognized,
          // this will filter out those cases too.
        ].filter(f => f)
      );
    }
    if (filterFn) {
      collection = collection.filter(filterFn);
    }
    return collection.toArray();
  }

  get(id) {
    return this.table.get(id);
  }

  /**
   * Method to remove the NEW_OBJECT
   * property so we don't commit it to IndexedDB
   * @param {Object} obj
   * @return {Object}
   */
  _cleanNew(obj) {
    const out = {
      ...obj,
    };
    delete out[NEW_OBJECT];
    return out;
  }

  update(id, changes) {
    return this.transaction('rw', () => {
      return this.table.update(id, this._cleanNew(changes));
    });
  }

  modifyByIds(ids, changes) {
    return this.transaction('rw', () => {
      return this.table
        .where(this.idField)
        .anyOf(ids)
        .modify(this._cleanNew(changes));
    });
  }

  /**
   * @param {Object|Collection} query
   * @return {Promise<mixed[]>}
   */
  _resolveQuery(query) {
    return new Promise(resolve => {
      if (query instanceof Collection) {
        resolve(query.toArray());
      } else if (query instanceof Dexie.Promise || query instanceof Promise || isArray(query)) {
        resolve(query);
      } else {
        resolve(this.where(query));
      }
    });
  }
  /**
   * Method to synchronously return a new object
   * suitable for insertion into IndexedDB but
   * without actually inserting it
   * @param {Object} obj
   * @return {Object}
   */
  createObj(obj) {
    return {
      ...this._preparePut(obj),
      [NEW_OBJECT]: true,
    };
  }

  _preparePut(obj) {
    const idMap = this._prepareCopy({});
    return this._cleanNew({
      ...idMap,
      ...obj,
    });
  }

  /**
   * @param {Object} obj
   * @return {Promise<string>}
   */
  put(obj) {
    return this.transaction('rw', () => {
      return this.table.put(this._preparePut(obj));
    });
  }

  /**
   * @param {Object[]} objs
   * @return {Promise<string[]>}
   */
  bulkPut(objs) {
    const putObjs = objs.map(this._preparePut);
    return this.transaction('rw', () => {
      return this.table.bulkPut(putObjs);
    });
  }

  /**
   * @param {Object} original
   * @return {Object}
   * @private
   */
  _prepareCopy(original) {
    const id = this.uuid ? { [this.idField]: uuid4() } : {};

    return this._cleanNew({
      ...original,
      ...id,
    });
  }

  delete(id) {
    return this.transaction('rw', () => {
      return this.table.delete(id);
    });
  }
}

class Resource extends mix(APIResource, IndexedDBResource) {
  constructor({ urlName, syncable = true, ...options } = {}) {
    super(options);
    this.urlName = urlName;
    API_RESOURCES[urlName] = this;
    // Overwrite the false default for IndexedDBResource
    this.syncable = syncable;
  }

  fetchCollection(params) {
    return client.get(this.collectionUrl(), { params }).then(response => {
      const now = Date.now();
      let itemData;
      let pageData;
      if (Array.isArray(response.data)) {
        itemData = response.data;
      } else {
        pageData = response.data;
        itemData = pageData.results;
      }
      const annotatedFilters = pick(params, this.annotatedFilters);
      return db.transaction('rw', this.tableName, CHANGES_TABLE, () => {
        // Explicitly set the source of this as a fetch
        // from the server, to prevent us from trying
        // to sync these changes back to the server!
        Dexie.currentTransaction.source = IGNORED_SOURCE;
        // Get any relevant changes that would be overwritten by this bulkPut
        return db[CHANGES_TABLE].where('[table+key]')
          .anyOf(itemData.map(datum => [this.tableName, datum[this.idField]]))
          .toArray(changes => {
            changes = mergeAllChanges(changes, true);
            const collectedChanges = collectChanges(changes)[this.tableName] || {};
            for (let changeType of Object.keys(collectedChanges)) {
              const map = {};
              for (let change of collectedChanges[changeType]) {
                map[change.key] = change;
              }
              collectedChanges[changeType] = map;
            }
            const data = itemData
              .map(datum => {
                datum[LAST_FETCHED] = now;
                Object.assign(datum, annotatedFilters);
                const id = datum[this.idField];
                // If we have a created change, apply the whole object here
                if (
                  collectedChanges[CHANGE_TYPES.CREATED] &&
                  collectedChanges[CHANGE_TYPES.CREATED][id]
                ) {
                  Object.assign(datum, collectedChanges[CHANGE_TYPES.CREATED][id].obj);
                }
                // If we have an updated change, apply the modifications here
                if (
                  collectedChanges[CHANGE_TYPES.UPDATED] &&
                  collectedChanges[CHANGE_TYPES.UPDATED][id]
                ) {
                  Object.assign(datum, collectedChanges[CHANGE_TYPES.UPDATED][id].mods);
                }
                return datum;
                // If we have a deleted change, just filter out this object so we don't reput it
              })
              .filter(
                datum =>
                  !collectedChanges[CHANGE_TYPES.DELETED] ||
                  !collectedChanges[CHANGE_TYPES.DELETED][datum[this.idField]]
              );
            return this.table.bulkPut(data).then(() => {
              // Move changes need to be reapplied on top of fetched data in case anything
              // has happened on the backend.
              const changes = Object.values(collectedChanges[CHANGE_TYPES.MOVED] || {});
              const appliedChangesPromise = changes.length
                ? applyChanges(changes)
                : Promise.resolve();
              return appliedChangesPromise.then(() => {
                // If someone has requested a paginated response,
                // they will be expecting the page data object,
                // not the results object.
                return pageData ? pageData : itemData;
              });
            });
          });
      });
    });
  }

  where(params = {}) {
    return super.where(params).then(objs => {
      if (!objs.length) {
        return this.requestCollection(params);
      }
      if (objectsAreStale(objs)) {
        this.requestCollection(params);
      }
      return objs;
    });
  }

  fetchModel(id) {
    return client.get(this.modelUrl(id)).then(response => {
      const now = Date.now();
      const data = response.data;
      data[LAST_FETCHED] = now;
      return db.transaction('rw', this.tableName, () => {
        // Explicitly set the source of this as a fetch
        // from the server, to prevent us from trying
        // to sync these changes back to the server!
        Dexie.currentTransaction.source = IGNORED_SOURCE;
        return this.table.put(data).then(() => {
          return data;
        });
      });
    });
  }

  get(id) {
    return this.table.get(id).then(obj => {
      if (obj) {
        return obj;
      }
      return this.requestModel(id);
    });
  }

  /**
   * The sync endpoint viewset must have a `copy` method for this to work
   *
   * @param {string} id
   * @param {Object|Function} updater
   * @return {Promise<mixed>}
   */
  copy(id, updater = {}) {
    return this.get(id).then(obj => {
      if (!obj) {
        return Promise.reject(new Error('Object not found'));
      }

      updater = resolveUpdater(updater);
      const mods = updater(obj);
      return db.transaction('rw', this.tableName, CHANGES_TABLE, () => {
        // Change source to ignored so we avoid tracking the changes. This is because
        // the copy call is a special call that will sync later, and we're replicating the
        // state here
        Dexie.currentTransaction.source = IGNORED_SOURCE;
        const copy = this._prepareCopy(obj);

        // We'll add manually our change record for syncing instead of letting our change
        // trackers handle it, because we've created a special copy operation. Without this
        // it would be tracked as a creation, and in some cases we need to do special updates
        // on the server for a copy
        return db[CHANGES_TABLE].put({
          key: copy.id,
          from_key: id,
          mods,
          table: this.tableName,
          type: CHANGE_TYPES.COPIED,
        }).then(() => this.table.put({ ...copy, ...mods }));
      });
    });
  }

  /**
   * The sync endpoint viewset must have a `copy` method for this to work
   *
   * @param {Object|Collection} query
   * @param {Object|Function} updater
   * @return {Promise<mixed[]>}
   */
  bulkCopy(query, updater = {}) {
    return this._resolveQuery(query).then(objs => {
      if (!objs.length) {
        return [];
      }

      updater = resolveUpdater(updater);
      return promiseChunk(objs, 20, chunk => {
        // We'll prep our updates, both to the target table, and the our `__changesForSyncing`
        // table, which we'll add manually instead of letting our change trackers handle it.
        // This is because we've created a special copy operation.  Without this would be
        // tracked as a creation, and in some cases we need to do special updates
        // on the server for a copy.
        const values = chunk.reduce(
          (values, obj) => {
            const mods = updater(obj);
            const base = this._prepareCopy(obj);
            const copy = {
              ...base,
              ...mods,
            };

            // The new copied object
            values[this.tableName].push(copy);

            // The change we'll sync, going into `__changesForSyncing`
            values[CHANGES_TABLE].push({
              key: copy.id,
              from_key: obj.id,
              mods,
              table: this.tableName,
              type: CHANGE_TYPES.COPIED,
              source: CLIENTID,
            });
            return values;
          },
          { [CHANGES_TABLE]: [], [this.tableName]: [] }
        );

        // We'll lock both the target table, and our changes table, then bulk put everything
        return db
          .transaction('rw', this.tableName, CHANGES_TABLE, () => {
            // Change source to ignored so we avoid tracking the changes. This is because
            // the copy call is a special call that will sync later, and we're replicating the
            // state here
            Dexie.currentTransaction.source = IGNORED_SOURCE;
            return promiseChunk(Object.keys(values), 1, table => {
              return db[table].bulkPut(values[table]);
            });
          })
          .then(() => values[this.tableName]);
      });
    });
  }
}

/**
 * @param {string} mode
 * @param {Function} callback
 * @return {Promise}
 */
function treeTransaction(mode, callback) {
  const tables = [TABLE_NAMES.CONTENTNODE, TABLE_NAMES.TREE, CHANGES_TABLE];
  return db.transaction(mode, ...tables, () => {
    Dexie.currentTransaction.source = CLIENTID;
    return callback();
  });
}

export const Channel = new Resource({
  tableName: TABLE_NAMES.CHANNEL,
  urlName: 'channel',
  indexFields: ['name', 'language'],
  annotatedFilters: ['bookmark', 'edit', 'view'],
  searchCatalog(params) {
    params.page_size = params.page_size || 100;
    params.public = true;
    // Because this is a heavily cached endpoint, we can just directly request
    // it and rely on browser caching to prevent excessive requests to the server.
    return client.get(window.Urls.catalog_list(), { params }).then(response => {
      return response.data;
    });
  },
  getCatalogChannel(id) {
    // Because this is a heavily cached endpoint, we can just directly request
    // it and rely on browser caching to prevent excessive requests to the server.
    return client.get(window.Urls.catalog_detail(id)).then(response => {
      return response.data;
    });
  },

  /**
   * Ensure we merge content defaults when calling `update`
   *
   * @param {String} id
   * @param {Object} [content_defaults]
   * @param {Object} changes
   * @return {Promise}
   */
  update(id, { content_defaults = {}, ...changes }) {
    return this.transaction('rw', () => {
      return this.table
        .where('id')
        .equals(id)
        .modify(channel => {
          if (Object.keys(content_defaults).length) {
            if (!channel.content_defaults) {
              channel.content_defaults = {};
            }
            Object.assign(channel.content_defaults, content_defaults);
          }

          Object.assign(channel, changes);
        });
    });
  },
});

export const ContentNode = new Resource({
  tableName: TABLE_NAMES.CONTENTNODE,
  urlName: 'contentnode',
  indexFields: ['title', 'language'],
  transaction: treeTransaction,
  /**
   * @param {string} id The ID of the node to treeCopy
   * @param {string} target The ID of the target node used for positioning
   * @param {string} position The position relative to `target`
   * @param {boolean} deep Whether or not to treeCopy all descendants
   * @return {Promise}
   */
  copy(id, target, position = 'last-child', deep = false) {
    if (!validPositions.has(position)) {
      throw new TypeError(`${position} is not a valid position`);
    }

    // Override the change type, since we'll be issuing the COPY change, so all we
    // need is the update to position, aka MOVED
    const changeType = CHANGE_TYPES.MOVED;
    return Tree.copy(id, target, position, deep, changeType).then(treeNodes => {
      return promiseChunk(treeNodes, 50, treeNodes => {
        return Tree.table
          .where('parent')
          .anyOf(uniq(treeNodes.map(n => n.parent)))
          .toArray()
          .then(siblings => {
            // Count all nodes with the same source that are siblings so we
            // can determine how many copies of the source element there are
            const countMap = siblings.reduce((countMap, sibling) => {
              if (!(sibling.parent in countMap)) {
                countMap[sibling.parent] = {};
              }

              if (!(sibling.source_id in countMap[sibling.parent])) {
                countMap[sibling.parent][sibling.source_id] = 0;
              }

              countMap[sibling.parent][sibling.source_id]++;
              return countMap;
            }, {});

            const sourceNodeMap = treeNodes.reduce((sourceNodeMap, treeNode) => {
              sourceNodeMap[treeNode.source_id] = treeNode;
              return sourceNodeMap;
            }, {});
            const sourceNodeIds = treeNodes.map(node => node.source_id);

            return promiseChunk(Object.keys(sourceNodeMap), 10, chunk => {
              // All of these should be loaded already, but we'll chunk anyway
              return Promise.all(chunk.map(id => Tree.get(id))).then(sourceTreeNodes => {
                return this.bulkCopy({ id__in: sourceNodeIds }, sourceNode => {
                  const treeNode = sourceNodeMap[sourceNode.id];
                  const sourceTreeNode = sourceTreeNodes.find(
                    sourceTreeNode => sourceTreeNode.id === treeNode.source_id
                  );
                  let title = sourceNode.title;

                  // When we've made a copy as a sibling of source, update the title
                  if (treeNode.parent === sourceTreeNode.parent) {
                    title =
                      countMap[treeNode.parent][treeNode.source_id] <= 2
                        ? constantStrings.$tr('firstCopy', { title })
                        : constantStrings.$tr('nthCopy', {
                            title,
                            n: countMap[treeNode.parent][treeNode.source_id],
                          });
                  }

                  return {
                    id: treeNode.id,
                    channel_id: treeNode.channel_id,
                    source_channel_id: sourceTreeNode.channel_id,
                    title,

                    // Should be removing these soon
                    files: [],
                    assessment_items: [],
                    prerequisite: [],
                  };
                });
              });
            });
          });
      }).then(nodes => {
        return {
          treeNodes,
          nodes,
        };
      });
    });
  },
});

export const ChannelSet = new Resource({
  tableName: TABLE_NAMES.CHANNELSET,
  urlName: 'channelset',
});

export const Invitation = new Resource({
  tableName: TABLE_NAMES.INVITATION,
  urlName: 'invitation',
});

export const User = new Resource({
  tableName: TABLE_NAMES.USER,
  urlName: 'user',
  uuid: false,
});

export const EditorM2M = new IndexedDBResource({
  tableName: TABLE_NAMES.EDITOR_M2M,
  indexFields: ['channel'],
  idField: '[user+channel]',
  uuid: false,
  put(channel, user) {
    return this.transaction('rw', CHANGES_TABLE, () => {
      return this.table.put({ user, channel }).then(() => {
        return db[CHANGES_TABLE].put({
          obj: {
            user,
            channel,
          },
          source: CLIENTID,
          table: this.tableName,
          type: CHANGE_TYPES.CREATED_RELATION,
        });
      });
    });
  },
});

export const ViewerM2M = new IndexedDBResource({
  tableName: TABLE_NAMES.VIEWER_M2M,
  indexFields: ['channel'],
  idField: '[user+channel]',
  uuid: false,
  delete(channel, user) {
    return this.transaction('rw', CHANGES_TABLE, () => {
      return this.table.delete([user, channel]).then(() => {
        return db[CHANGES_TABLE].put({
          obj: {
            user,
            channel,
          },
          source: CLIENTID,
          table: this.tableName,
          type: CHANGE_TYPES.DELETED_RELATION,
        });
      });
    });
  },
});

export const ChannelUser = new APIResource({
  urlName: 'channeluser',
  makeEditor(channel, user) {
    return ViewerM2M.delete(channel, user).then(() => {
      return EditorM2M.put(channel, user);
    });
  },
  removeViewer(channel, user) {
    return ViewerM2M.delete(channel, user);
  },
  fetchCollection(params) {
    return client.get(this.collectionUrl(), { params }).then(response => {
      const now = Date.now();
      const itemData = response.data;
      const userData = [];
      const editorM2M = [];
      const viewerM2M = [];
      for (let datum of itemData) {
        const userDatum = {
          ...datum,
        };
        userDatum[LAST_FETCHED] = now;
        delete userDatum.can_edit;
        delete userDatum.can_view;
        userData.push(userDatum);
        const m2mDatum = {
          [LAST_FETCHED]: now,
          user: datum.id,
          channel: params.channel,
        };
        if (datum.can_edit) {
          editorM2M.push(m2mDatum);
        } else if (datum.can_view) {
          viewerM2M.push(m2mDatum);
        }
      }

      return db.transaction('rw', User.tableName, EditorM2M.tableName, ViewerM2M.tableName, () => {
        // Explicitly set the source of this as a fetch
        // from the server, to prevent us from trying
        // to sync these changes back to the server!
        Dexie.currentTransaction.source = IGNORED_SOURCE;
        return Promise.all([
          EditorM2M.table.bulkPut(editorM2M),
          ViewerM2M.table.bulkPut(viewerM2M),
          User.table.bulkPut(userData),
        ]).then(() => {
          return itemData;
        });
      });
    });
  },
  where({ channel }) {
    if (!channel) {
      throw TypeError('Not a valid channelId');
    }
    const params = {
      channel,
    };
    const editorCollection = EditorM2M.table.where(params);
    const viewerCollection = ViewerM2M.table.where(params);
    return Promise.all([editorCollection.toArray(), viewerCollection.toArray()]).then(
      ([editors, viewers]) => {
        if (!editors.length && !viewers.length) {
          return this.requestCollection(params);
        }
        if (objectsAreStale(editors) || objectsAreStale(viewers)) {
          // Do a synchronous refresh instead of background refresh here.
          return this.requestCollection(params);
        }
        const editorSet = new Set(editors.map(editor => editor.user));
        const viewerSet = new Set(viewers.map(viewer => viewer.user));
        // Directly query indexeddb here, to avoid triggering
        // an additional request if the user data is stale but the M2M table data is not.
        return User.table
          .where('id')
          .anyOf(...editorSet.values(), ...viewerSet.values())
          .toArray(users => {
            return users.map(user => {
              const can_edit = editorSet.has(user.id);
              const can_view = viewerSet.has(user.id);
              return {
                ...user,
                can_edit,
                can_view,
              };
            });
          });
      }
    );
  },
});

export const AssessmentItem = new Resource({
  tableName: TABLE_NAMES.ASSESSMENTITEM,
  urlName: 'assessmentitem',
  idField: 'assessment_id',
  indexFields: ['contentnode'],
});

export const File = new Resource({
  tableName: TABLE_NAMES.FILE,
  urlName: 'file',
  indexFields: ['contentnode'],
});

export const Tree = new Resource({
  tableName: TABLE_NAMES.TREE,
  urlName: 'tree',
  indexFields: [
    'channel_id',
    'parent',
    'source_id',
    'tree_id',
    'lft',
    '[tree_id+parent]',
    '[channel_id+parent]',
  ],
  // Any changes made to the tree table should only be propagated to the
  // backend via moves, so that we can make local tree changes in the frontend
  // and have them replicated in the backend on the global tree state.
  syncable: false,
  // ids have to exactly correlate with content node ids, so don't auto
  // set uuids on this table.
  uuid: false,
  transaction: treeTransaction,

  /**
   * @param {string} target
   * @param {string} position
   * @return {Promise<string>}
   */
  resolveParent(target, position) {
    return new Promise((resolve, reject) => {
      if (
        position === RELATIVE_TREE_POSITIONS.FIRST_CHILD ||
        position === RELATIVE_TREE_POSITIONS.LAST_CHILD
      ) {
        resolve(target);
      } else {
        this.table.get(target).then(node => {
          if (node) {
            resolve(node.parent);
          } else {
            reject(new RangeError(`Target ${target} does not exist`));
          }
        });
      }
    });
  },

  /**
   * @param {string} target
   * @param {string} position
   * @return {Promise<{parent: string, siblings: Object[]}>}
   */
  getNewParentAndSiblings(target, position) {
    return this.resolveParent(target, position).then(parent => {
      return this.table
        .where({ parent })
        .sortBy('lft')
        .then(siblings => ({ parent, siblings }));
    });
  },

  /**
   * @param {string} id
   * @param {string} target
   * @param {string} position
   * @param {Object[]} siblings
   * @return {null|number}
   */
  getNewSortOrder(id, target, position, siblings) {
    // Check if this is a no-op
    const targetNodeIndex = findIndex(siblings, { id: target });

    if (
      // We are trying to move it to the first child, and it is already the first child
      // when sorted by lft
      (position === RELATIVE_TREE_POSITIONS.FIRST_CHILD && siblings[0].id === id) ||
      // We are trying to move it to the last child, and it is already the last child
      // when sorted by lft
      (position === RELATIVE_TREE_POSITIONS.LAST_CHILD && siblings.slice(-1)[0].id === id) ||
      // We are trying to move it to the immediate left of the target node,
      // but it is already to the immediate left of the target node.
      (position === RELATIVE_TREE_POSITIONS.LEFT &&
        targetNodeIndex > 0 &&
        siblings[targetNodeIndex - 1].id === id) ||
      // We are trying to move it to the immediate right of the target node,
      // but it is already to the immediate right of the target node.
      (position === RELATIVE_TREE_POSITIONS.RIGHT &&
        targetNodeIndex < siblings.length - 2 &&
        siblings[targetNodeIndex + 1].id === id)
    ) {
      return null;
    }

    if (position === RELATIVE_TREE_POSITIONS.FIRST_CHILD) {
      // For first child, just halve the first child sort order.
      return siblings[0].lft / 2;
    } else if (position === RELATIVE_TREE_POSITIONS.LAST_CHILD) {
      // For the last child, just add one to the final child sort order.
      return siblings.slice(-1)[0].lft + 1;
    } else if (position === RELATIVE_TREE_POSITIONS.LEFT) {
      // For left insertion, either find the middle value between the node that would be to
      // the left of the newly inserted node and the node that we are inserting to the
      // left of.
      // If the node we are inserting to the left of is already the leftmost node of this
      // parent, then we fallback to the same calculation as a first child insert.
      const leftSort = siblings[targetNodeIndex - 1] ? siblings[targetNodeIndex - 1].lft : 0;
      return (leftSort + siblings[targetNodeIndex].lft) / 2;
    } else if (position === RELATIVE_TREE_POSITIONS.RIGHT) {
      // For right insertion, similarly to left insertion, we find the middle value between
      // the node that will be to the right of the inserted node and the node we are
      // inserting to the right of.
      // If there is no node to the right, and the target node is already the rightmost
      // node, we produce a sort order value that is the same as we would calculate for a
      // last child insertion.
      const rightSort = siblings[targetNodeIndex + 1]
        ? siblings[targetNodeIndex + 1].lft
        : siblings[targetNodeIndex].lft + 2;
      return (siblings[targetNodeIndex].lft + rightSort) / 2;
    }

    return null;
  },

  move(id, target, position = RELATIVE_TREE_POSITIONS.FIRST_CHILD) {
    if (!validPositions.has(position)) {
      throw new TypeError(`${position} is not a valid position`);
    }
    return this.transaction('rw', () => {
      return this.tableMove(id, target, position);
    });
  },

  tableMove(id, target, position) {
    if (!validPositions.has(position)) {
      return Promise.reject();
    }
    // This implements a 'parent local' algorithm
    // to produce locally consistent node moves
    return this.getNewParentAndSiblings(target, position).then(({ parent, siblings }) => {
      let lft = 1;
      if (siblings.length) {
        lft = this.getNewSortOrder(id, target, position, siblings);
      } else {
        // if there are no siblings, overwrite
        target = parent;
        position = RELATIVE_TREE_POSITIONS.LAST_CHILD;
      }

      let data = { parent, lft };
      let oldObj = null;
      return this.table
        .get(id)
        .then(node => {
          oldObj = node;
          return this.table.update(id, data);
        })
        .then(updated => {
          if (updated) {
            // Update succeeded
            return { id, ...data };
          }
          // Update didn't succeed, this node probably doesn't exist, do a put instead,
          // but need to add in other parent info.
          return this.table.get(parent).then(parentNode => {
            data = {
              id,
              parent,
              lft,
              tree_id: parentNode.tree_id,
              channel_id: parentNode.channel_id,
              source_id: null,
            };
            return this.table.put(data).then(() => data);
          });
        })
        .then(data => {
          return db[CHANGES_TABLE].put({
            key: id,
            mods: {
              target,
              position,
            },
            oldObj,
            source: CLIENTID,
            table: this.tableName,
            type: CHANGE_TYPES.MOVED,
          }).then(() => data);
        });
    });
  },

  /**
   * @param {string} id - The ID of the node to treeCopy
   * @param {string} target - The ID of the target node used for positioning
   * @param {string} [position] - The position relative to `target`
   * @param {boolean} [deep] - Whether or not to treeCopy all descendants
   * @param {number} [changeType] - Override the change type
   * @return {Promise<Object[]>}
   */
  copy(
    id,
    target,
    position = RELATIVE_TREE_POSITIONS.LAST_CHILD,
    deep = false,
    changeType = CHANGE_TYPES.COPIED
  ) {
    if (!validPositions.has(position)) {
      throw new TypeError(`${position} is not a valid position`);
    }

    return this.transaction('rw', () => {
      return this.tableCopy(id, target, position, changeType);
    })
      .then(data => {
        if (!deep) {
          return [data];
        }

        return this.table
          .where({ parent: id })
          .sortBy('lft')
          .then(children => {
            // Chunk children, and call `copy` again for each, merging all results together
            return promiseChunk(children, 50, children => {
              return Promise.all(
                children.map(child => {
                  // Recurse for all children of the node we just copied
                  return this.copy(
                    child.id,
                    data.id,
                    RELATIVE_TREE_POSITIONS.LAST_CHILD,
                    deep,
                    changeType
                  );
                })
              );
            });
          })
          .then(results => {
            return results.reduce((all, subset) => all.concat(subset), []);
          })
          .then(results => {
            // Be sure to add our first node's result to the beginning of our results
            results.unshift(data);
            return results;
          });
      })
      .then(results => {
        if (changeType === CHANGE_TYPES.COPIED) {
          return results;
        }

        return this.transaction('rw', () => {
          // Change source to ignored so we avoid tracking the changes. This is because
          // the creation of tree node here is creating a bare content node, so we'll put the
          // ID in IndexedDB so later updates sync correctly
          Dexie.currentTransaction.source = IGNORED_SOURCE;
          return ContentNode.table.bulkPut(results.map(result => ({ id: result.id })));
        }).then(() => results);
      });
  },

  tableCopy(id, target, position, changeType) {
    if (!validPositions.has(position)) {
      return Promise.reject();
    }

    return this.getNewParentAndSiblings(target, position)
      .then(({ parent, siblings }) => {
        let lft = 1;

        if (siblings.length) {
          lft = this.getNewSortOrder(id, target, position, siblings);
        } else {
          // if there are no siblings, overwrite
          target = parent;
          position = RELATIVE_TREE_POSITIONS.LAST_CHILD;
        }

        const data = {
          id: uuid4(),
          source_id: id,
          lft,
        };

        // Get source node and parent so we can reference some specifics
        const node = this.table.get(id);
        const parentNode = this.table.get(parent);

        // Next, we'll add the new tree node immediately
        return Promise.all([node, parentNode]).then(([node, parentNode]) => ({
          ...data,
          tree_id: parentNode.tree_id,
          channel_id: node.channel_id,
          parent: parentNode.id,
          level: parentNode.level + 1,
        }));
      })
      .then(data => this.table.put(data).then(() => data))
      .then(data => {
        // Manually put our changes into the tree changes for syncing table
        const { id: key, lft, channel_id } = data;
        return db[CHANGES_TABLE].put({
          key,
          from_key: id,
          mods: {
            target,
            position,
            lft,
            channel_id,
          },
          source: CLIENTID,
          oldObj: null,
          table: this.tableName,
          type: changeType,
        }).then(() => data);
      });
  },
});
