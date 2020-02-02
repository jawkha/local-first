// @flow

import type { Client, Collection } from '../types';
import type {
    Persistence,
    Network,
    ClockPersist,
    DeltaPersistence,
    FullPersistence,
    NetworkCreator,
} from './types';
import type { HLC } from '@local-first/hybrid-logical-clock';
import * as hlc from '@local-first/hybrid-logical-clock';
import deepEqual from 'fast-deep-equal';
import { type PeerChange } from '../client';

import {
    newCollection,
    getCollection,
    onCrossTabChanges,
    type CRDTImpl,
    type CollectionState,
} from './shared';

// const setDeep = (obj: any, path, value) => {
//     if (!obj) {
//         return false;
//     }
//     let cur = obj;
//     for (let i = 0; i < path.length - 1; i++) {
//         cur = cur[path[i]];
//         if (!cur) {
//             return false;
//         }
//     }
//     cur[path[path.length - 1]] = value;
//     return true;
// };

const genId = () =>
    Math.random()
        .toString(36)
        .slice(2);

import { type ClientMessage, type ServerMessage } from '../server';
const getMessages = function<Delta, Data>(
    persistence: DeltaPersistence,
    reconnected: boolean,
): Promise<Array<ClientMessage<Delta, Data>>> {
    return Promise.all(
        persistence.collections.map(async (id: string): Promise<?ClientMessage<
            Delta,
            Data,
        >> => {
            const deltas = await persistence.deltas(id);
            const serverCursor = await persistence.getServerCursor(id);
            if (deltas.length || !serverCursor || reconnected) {
                return {
                    type: 'sync',
                    collection: id,
                    serverCursor,
                    deltas: deltas.map(({ node, delta }) => ({
                        node,
                        delta,
                    })),
                };
            }
        }),
    ).then(a => a.filter(Boolean));
};

const handleMessages = async function<Delta, Data>(
    crdt: CRDTImpl<Delta, Data>,
    persistence: DeltaPersistence,
    messages: Array<ServerMessage<Delta, Data>>,
    state: { [colid: string]: CollectionState<Data, any> },
    recvClock: HLC => void,
    sendCrossTabChanges: PeerChange => mixed,
) {
    await Promise.all(
        messages.map(async msg => {
            if (msg.type === 'sync') {
                const col = state[msg.collection];

                const changed = {};
                msg.deltas.forEach(delta => {
                    changed[delta.node] = true;
                });

                const deltasWithStamps = msg.deltas.map(delta => ({
                    ...delta,
                    stamp: crdt.deltas.stamp(delta.delta),
                }));

                const changedIds = Object.keys(changed);
                const data = await persistence.applyDeltas(
                    msg.collection,
                    deltasWithStamps,
                    msg.serverCursor,
                    (data, delta) => crdt.deltas.apply(data, delta),
                );

                if (col.listeners.length) {
                    const changes = changedIds.map(id => ({
                        id,
                        value: crdt.value(data[id]),
                    }));
                    col.listeners.forEach(listener => {
                        listener(changes);
                    });
                }
                changedIds.forEach(id => {
                    // Only update the cache if the node has already been cached
                    if (state[msg.collection].cache[id]) {
                        state[msg.collection].cache[id] = data[id];
                    }
                    if (col.itemListeners[id]) {
                        col.itemListeners[id].forEach(fn =>
                            fn(crdt.value(data[id])),
                        );
                    }
                });

                if (changedIds.length) {
                    console.log(
                        'Broadcasting to client-level listeners',
                        changedIds,
                    );
                    sendCrossTabChanges({
                        col: msg.collection,
                        nodes: changedIds,
                    });
                }

                let maxStamp = null;
                msg.deltas.forEach(delta => {
                    const stamp = crdt.deltas.stamp(delta.delta);
                    if (!maxStamp || stamp > maxStamp) {
                        maxStamp = stamp;
                    }
                });
                if (maxStamp) {
                    recvClock(hlc.unpack(maxStamp));
                }
            } else if (msg.type === 'ack') {
                return persistence.deleteDeltas(msg.collection, msg.deltaStamp);
            }
        }),
    );
};

function createClient<Delta, Data, SyncStatus>(
    crdt: CRDTImpl<Delta, Data>,
    clockPersist: ClockPersist,
    persistence: DeltaPersistence,
    createNetwork: NetworkCreator<Delta, Data, SyncStatus>,
): Client<SyncStatus> {
    let clock = clockPersist.get(() => hlc.init(genId(), Date.now()));
    const state: { [key: string]: CollectionState<Data, any> } = {};
    persistence.collections.forEach(id => (state[id] = newCollection()));

    const getStamp = () => {
        clock = hlc.inc(clock, Date.now());
        clockPersist.set(clock);
        return hlc.pack(clock);
    };

    const setClock = (newClock: HLC) => {
        clock = newClock;
        clockPersist.set(clock);
    };

    const recvClock = (newClock: HLC) => {
        clock = hlc.recv(clock, newClock, Date.now());
        clockPersist.set(clock);
    };

    const network = createNetwork(
        clock.node,
        fresh => getMessages(persistence, fresh),
        (messages, sendCrossTabChanges) =>
            handleMessages(
                crdt,
                persistence,
                messages,
                state,
                recvClock,
                sendCrossTabChanges,
            ),
        (msg: PeerChange) => {
            return onCrossTabChanges(
                crdt,
                persistence,
                state[msg.col],
                msg.col,
                msg.nodes,
            );
        },
    );

    return {
        sessionId: clock.node,
        getStamp,
        getCollection<T>(colid: string) {
            return getCollection(
                colid,
                crdt,
                persistence,
                state[colid],
                getStamp,
                network.setDirty,
            );
        },
        onSyncStatus(fn) {
            network.onSyncStatus(fn);
        },
        getSyncStatus() {
            return network.getSyncStatus();
        },
    };
}

export default createClient;
