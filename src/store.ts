import {
  watch,
  computed,
  inject,
  getCurrentInstance,
  reactive,
  DebuggerEvent,
  WatchOptions,
  UnwrapRef,
  markRaw,
  isRef,
  isReactive,
  effectScope,
  EffectScope,
  onUnmounted,
  ComputedRef,
  toRef,
  toRefs,
} from 'vue'
import {
  StateTree,
  SubscriptionCallback,
  DeepPartial,
  isPlainObject,
  Store,
  _Method,
  DefineStoreOptions,
  StoreDefinition,
  GettersTree,
  MutationType,
  StoreOnActionListener,
  ActionsTree,
  SubscriptionCallbackMutation,
  _UnionToTuple,
  DefineSetupStoreOptions,
  DefineStoreOptionsInPlugin,
} from './types'
import {
  getActivePinia,
  setActivePinia,
  piniaSymbol,
  Pinia,
  activePinia,
} from './rootStore'
import { IS_CLIENT } from './env'

function innerPatch<T extends StateTree>(
  target: T,
  patchToApply: DeepPartial<T>
): T {
  // no need to go through symbols because they cannot be serialized anyway
  for (const key in patchToApply) {
    const subPatch = patchToApply[key]
    const targetValue = target[key]
    if (
      isPlainObject(targetValue) &&
      isPlainObject(subPatch) &&
      !isRef(subPatch) &&
      !isReactive(subPatch)
    ) {
      target[key] = innerPatch(targetValue, subPatch)
    } else {
      // @ts-ignore
      target[key] = subPatch
    }
  }

  return target
}

const { assign } = Object

function isComputed(o: any): o is ComputedRef {
  return o && o.effect && o.effect.computed
}

function createOptionsStore<
  Id extends string,
  S extends StateTree,
  G extends GettersTree<S>,
  A extends ActionsTree
>(options: DefineStoreOptions<Id, S, G, A>, pinia: Pinia): Store<Id, S, G, A> {
  const { id, state, actions, getters } = options
  function $reset() {
    pinia.state.value[id] = state ? state() : {}
  }

  function setup() {
    $reset()
    // pinia.state.value[id] = state ? state() : {}

    return assign(
      toRefs(pinia.state.value[id]),
      actions,
      Object.keys(getters || {}).reduce((computedGetters, name) => {
        computedGetters[name] = computed(() => {
          setActivePinia(pinia)
          // @ts-expect-error
          return getters![name].call(store, store)
        })
        return computedGetters
      }, {} as Record<string, ComputedRef>)
    )
  }

  const store = createSetupStore(id, setup, options)

  store.$reset = $reset

  return store as any
}

const noop = () => {}

function createSetupStore<
  Id extends string,
  SS,
  S extends StateTree,
  G extends ActionsTree, // TODO: naming
  A extends ActionsTree
>(
  $id: Id,
  setup: () => SS,
  options:
    | DefineSetupStoreOptions<Id, S, G, A>
    | DefineStoreOptions<Id, S, G, A> = {}
): Store<Id, S, G, A> {
  const pinia = getActivePinia()
  let scope!: EffectScope
  const buildState = (options as DefineStoreOptions<Id, S, G, A>).state

  const optionsForPlugin: DefineStoreOptionsInPlugin<Id, S, G, A> = {
    actions: {} as A,
    ...options,
  }

  // watcher options for $subscribe
  const $subscribeOptions: WatchOptions = { deep: true, flush: 'sync' }
  /* istanbul ignore else */
  if (__DEV__) {
    $subscribeOptions.onTrigger = (event) => {
      if (isListening) {
        debuggerEvents = event
      } else {
        // let patch send all the events together later
        /* istanbul ignore else */
        if (Array.isArray(debuggerEvents)) {
          debuggerEvents.push(event)
        } else {
          console.error(
            '🍍 debuggerEvents should be an array. This is most likely an internal Pinia bug.'
          )
        }
      }
    }
  }

  // internal state
  let isListening = false // set to true at the end
  let subscriptions: SubscriptionCallback<S>[] = markRaw([])
  let actionSubscriptions: StoreOnActionListener<Id, S, G, A>[] = markRaw([])
  let debuggerEvents: DebuggerEvent[] | DebuggerEvent
  const initialState = pinia.state.value[$id] as UnwrapRef<S> | undefined

  if (!initialState) {
    // should be set in Vue 2
    pinia.state.value[$id] = {}
  }

  const triggerSubscriptions: SubscriptionCallback<S> = (mutation, state) => {
    subscriptions.forEach((callback) => {
      callback(mutation, state)
    })
  }

  if (__DEV__ && !pinia._e.active) {
    // TODO: warn in dev
    throw new Error('Pinia destroyed')
  }

  // TODO: idea create skipSerialize that marks properties as non serializable and they are skipped
  // TODO: store the scope somewhere
  const setupStore = pinia._e.run(() => {
    scope = effectScope()
    return scope.run(() => {
      const store = setup()

      watch(
        () => pinia.state.value[$id] as UnwrapRef<S>,
        (state, oldState) => {
          if (isListening) {
            triggerSubscriptions(
              {
                storeId: $id,
                type: MutationType.direct,
                events: debuggerEvents as DebuggerEvent,
              },
              state
            )
          }
        },
        $subscribeOptions
      )!

      return store
    })
  })!

  function $patch(stateMutation: (state: UnwrapRef<S>) => void): void
  function $patch(partialState: DeepPartial<UnwrapRef<S>>): void
  function $patch(
    partialStateOrMutator:
      | DeepPartial<UnwrapRef<S>>
      | ((state: UnwrapRef<S>) => void)
  ): void {
    let subscriptionMutation: SubscriptionCallbackMutation<S>
    isListening = false
    // reset the debugger events since patches are sync
    /* istanbul ignore else */
    if (__DEV__) {
      debuggerEvents = []
    }
    if (typeof partialStateOrMutator === 'function') {
      partialStateOrMutator(pinia.state.value[$id] as UnwrapRef<S>)
      subscriptionMutation = {
        type: MutationType.patchFunction,
        storeId: $id,
        events: debuggerEvents as DebuggerEvent[],
      }
    } else {
      innerPatch(pinia.state.value[$id], partialStateOrMutator)
      subscriptionMutation = {
        type: MutationType.patchObject,
        payload: partialStateOrMutator,
        storeId: $id,
        events: debuggerEvents as DebuggerEvent[],
      }
    }
    isListening = true
    // because we paused the watcher, we need to manually call the subscriptions
    triggerSubscriptions(
      subscriptionMutation,
      pinia.state.value[$id] as UnwrapRef<S>
    )
  }

  // TODO: refactor duplicated code for subscriptions
  function $subscribe(callback: SubscriptionCallback<S>, detached?: boolean) {
    subscriptions.push(callback)

    const removeSubscription = () => {
      const idx = subscriptions.indexOf(callback)
      if (idx > -1) {
        subscriptions.splice(idx, 1)
      }
    }

    if (!detached && getCurrentInstance()) {
      onUnmounted(removeSubscription)
    }

    return removeSubscription
  }

  function $onAction(
    callback: StoreOnActionListener<Id, S, G, A>,
    detached?: boolean
  ) {
    actionSubscriptions.push(callback)

    const removeSubscription = () => {
      const idx = actionSubscriptions.indexOf(callback)
      if (idx > -1) {
        actionSubscriptions.splice(idx, 1)
      }
    }

    if (!detached && getCurrentInstance()) {
      onUnmounted(removeSubscription)
    }

    return removeSubscription
  }

  function $reset() {
    // TODO: is it worth? probably should be removed
    // maybe it can stop the effect and create it again but should be a plugin
    if (buildState) {
      pinia.state.value[$id] = buildState()
    } else if (__DEV__) {
      throw new Error(
        `🍍: Store "${$id}" is build using the setup syntax and does not implement $reset().`
      )
    }
  }

  // overwrite existing actions to support $onAction
  for (const key in setupStore) {
    const prop = setupStore[key]

    if ((isRef(prop) && !isComputed(prop)) || isReactive(prop)) {
      // createOptionStore already did this
      if (!buildState) {
        // mark it as a piece of state to be serialized
        pinia.state.value[$id][key] = toRef(setupStore as any, key)
      }
      // action
    } else if (typeof prop === 'function') {
      // @ts-expect-error: we are overriding the function
      setupStore[key] = function () {
        setActivePinia(pinia)
        const args = Array.from(arguments)

        let afterCallback: (resolvedReturn: any) => void = noop
        let onErrorCallback: (error: unknown) => void = noop
        function after(callback: typeof afterCallback) {
          afterCallback = callback
        }
        function onError(callback: typeof onErrorCallback) {
          onErrorCallback = callback
        }

        actionSubscriptions.forEach((callback) => {
          // @ts-expect-error
          callback({
            args,
            name: key,
            store,
            after,
            onError,
          })
        })

        let ret: any
        try {
          ret = prop.apply(this || store, args)
          Promise.resolve(ret).then(afterCallback).catch(onErrorCallback)
        } catch (error) {
          onErrorCallback(error)
          throw error
        }

        return ret
      }
      // list actions so they can be used in plugins
      // @ts-expect-error
      optionsForPlugin.actions[key] = prop
    } else if (__DEV__ && IS_CLIENT) {
      // add getters for devtools
      if (isComputed(prop)) {
        const getters: string[] =
          // @ts-expect-error: it should be on the store
          setupStore._getters || (setupStore._getters = markRaw([]))
        getters.push(key)
      }
    }
  }

  const partialStore = {
    _p: pinia,
    $id,
    $onAction,
    $patch,
    $reset,
    $subscribe,
  }

  const store: Store<Id, S, G, A> = reactive(
    assign(
      __DEV__ && IS_CLIENT
        ? // devtools custom properties
          {
            _customProperties: markRaw(new Set<string>()),
          }
        : {},
      partialStore,
      setupStore
    )
  ) as Store<Id, S, G, A>

  // use this instead of a computed with setter to be able to create it anywhere
  // without linking the computed lifespan to wherever the store is first
  // created.
  Object.defineProperty(store, '$state', {
    get: () => pinia.state.value[$id],
    set: (state) => (pinia.state.value[$id] = state),
  })

  // apply all plugins
  pinia._p.forEach((extender) => {
    if (__DEV__ && IS_CLIENT) {
      const extensions = extender({
        // @ts-expect-error: conflict between A and ActionsTree
        store,
        app: pinia._a,
        pinia,
        // @ts-expect-error
        options: optionsForPlugin,
      })
      Object.keys(extensions || {}).forEach((key) =>
        store._customProperties.add(key)
      )
      assign(store, extensions)
    } else {
      assign(
        store,
        extender({
          // @ts-expect-error: conflict between A and ActionsTree
          store,
          app: pinia._a,
          pinia,
          // @ts-expect-error
          options: optionsForPlugin,
        })
      )
    }
  })

  if (initialState) {
    ;(options.hydrate || innerPatch)(store, initialState)
  }

  isListening = true
  return store
}

// export function disposeStore(store: Store) {
//   store._e

// }

type _SpreadStateFromStore<SS, K extends readonly any[]> = K extends readonly [
  infer A,
  ...infer Rest
]
  ? A extends string | number | symbol
    ? SS extends Record<A, _Method | ComputedRef<any>>
      ? _SpreadStateFromStore<SS, Rest>
      : SS extends Record<A, any>
      ? Record<A, UnwrapRef<SS[A]>> & _SpreadStateFromStore<SS, Rest>
      : never
    : {}
  : {}

type _SpreadPropertiesFromObject<
  SS,
  K extends readonly any[],
  T
> = K extends readonly [infer A, ...infer Rest]
  ? A extends string | number | symbol
    ? SS extends Record<A, T>
      ? Record<A, UnwrapRef<SS[A]>> & _SpreadPropertiesFromObject<SS, Rest, T>
      : _SpreadPropertiesFromObject<SS, Rest, T>
    : {}
  : {}

type _ExtractStateFromSetupStore<SS> = _SpreadStateFromStore<
  SS,
  _UnionToTuple<keyof SS>
>

type _ExtractActionsFromSetupStore<SS> = _SpreadPropertiesFromObject<
  SS,
  _UnionToTuple<keyof SS>,
  _Method
>

type _ExtractGettersFromSetupStore<SS> = _SpreadPropertiesFromObject<
  SS,
  _UnionToTuple<keyof SS>,
  ComputedRef<any>
>

// type a1 = _ExtractStateFromSetupStore<{ a: Ref<number>; action: () => void }>
// type a2 = _ExtractActionsFromSetupStore<{ a: Ref<number>; action: () => void }>
// type a3 = _ExtractGettersFromSetupStore<{
//   a: Ref<number>
//   b: ComputedRef<string>
//   action: () => void
// }>

/**
 * Creates a `useStore` function that retrieves the store instance
 *
 * @param options - options to define the store
 */
export function defineSetupStore<Id extends string, SS>(
  id: Id,
  storeSetup: () => SS,
  options?: DefineSetupStoreOptions<
    Id,
    _ExtractStateFromSetupStore<SS>,
    _ExtractGettersFromSetupStore<SS>,
    _ExtractActionsFromSetupStore<SS>
  >
): StoreDefinition<
  Id,
  _ExtractStateFromSetupStore<SS>,
  _ExtractGettersFromSetupStore<SS>,
  _ExtractActionsFromSetupStore<SS>
> {
  function useStore(
    pinia?: Pinia | null
  ): Store<
    Id,
    _ExtractStateFromSetupStore<SS>,
    _ExtractGettersFromSetupStore<SS>,
    _ExtractActionsFromSetupStore<SS>
  > {
    const currentInstance = getCurrentInstance()
    pinia =
      // in test mode, ignore the argument provided as we can always retrieve a
      // pinia instance with getActivePinia()
      (__TEST__ && activePinia && activePinia._testing ? null : pinia) ||
      (currentInstance && inject(piniaSymbol))
    if (pinia) setActivePinia(pinia)
    // TODO: worth warning on server if no piniaKey as it can leak data
    pinia = getActivePinia()

    if (!pinia._s.has(id)) {
      pinia._s.set(id, createSetupStore(id, storeSetup, options))
    }

    const store: Store<
      Id,
      _ExtractStateFromSetupStore<SS>,
      _ExtractGettersFromSetupStore<SS>,
      _ExtractActionsFromSetupStore<SS>
    > = pinia._s.get(id)! as Store<
      Id,
      _ExtractStateFromSetupStore<SS>,
      _ExtractGettersFromSetupStore<SS>,
      _ExtractActionsFromSetupStore<SS>
    >

    // save stores in instances to access them devtools
    if (__DEV__ && IS_CLIENT && currentInstance && currentInstance.proxy) {
      const vm = currentInstance.proxy
      const cache = '_pStores' in vm ? vm._pStores! : (vm._pStores = {})
      // @ts-expect-error: still can't cast Store with generics to Store
      cache[id] = store
    }

    return store
  }

  useStore.$id = id

  return useStore
}

/**
 * Creates a `useStore` function that retrieves the store instance
 *
 * @param options - options to define the store
 */
export function defineStore<
  Id extends string,
  S extends StateTree,
  G extends GettersTree<S>,
  // cannot extends ActionsTree because we loose the typings
  A /* extends ActionsTree */
>(options: DefineStoreOptions<Id, S, G, A>): StoreDefinition<Id, S, G, A> {
  const { id } = options

  function useStore(pinia?: Pinia | null) {
    const currentInstance = getCurrentInstance()
    pinia =
      // in test mode, ignore the argument provided as we can always retrieve a
      // pinia instance with getActivePinia()
      (__TEST__ && activePinia && activePinia._testing ? null : pinia) ||
      (currentInstance && inject(piniaSymbol))
    if (pinia) setActivePinia(pinia)
    // TODO: worth warning on server if no piniaKey as it can leak data
    pinia = getActivePinia()

    if (!pinia._s.has(id)) {
      pinia._s.set(
        id,
        createOptionsStore(
          // @ts-expect-error: bad actions
          options,
          pinia
        )
      )
    }

    const store: Store<Id, S, G, A> = pinia._s.get(id)! as Store<Id, S, G, A>

    // save stores in instances to access them devtools
    if (__DEV__ && IS_CLIENT && currentInstance && currentInstance.proxy) {
      const vm = currentInstance.proxy
      const cache = '_pStores' in vm ? vm._pStores! : (vm._pStores = {})
      // @ts-expect-error: still can't cast Store with generics to Store
      cache[id] = store
    }

    return store
  }

  useStore.$id = id

  return useStore
}
