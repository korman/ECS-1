
// 重构原则：如无必要，勿增实体。
export module ecs {
    //#region 类型声明
    type ComponentConstructor<T extends IComponent = IComponent> = {
        /**
         * 每类组件的唯一id
         */
        tid: number;
        /**
         * 组件名称，可用作实体对象的属性名称。
         */
        compName: string;
        new(): T;
    }
    type ComponentAddOrRemove = (entity: Entity) => void;
    //#endregion

    //#region 注册组件
    /**
     * 组件里面只放数据可能在实际写代码的时候比较麻烦。如果是单纯对组件内的数据操作可以在组件里面写方法。
     */
    export abstract class IComponent {
        /**
         * 组件的类型id，-1表示未给该组件分配id
         */
        static tid: number = -1;
        static compName: string;
        /**
         * 组件所在的实体对象
         */
        ent!: ecs.Entity;
        /**
         * 组件被回收时会调用这个接口。可以在这里重置数据，或者解除引用。
         */
        abstract reset(): void;
    }

    /**
     * 组件类型id
     */
    let compTid = 0;
    /**
     * 组件构造函数
     */
    let componentConstructors: ComponentConstructor[] = [];
    /**
     * 由于js打包会改变类名，所以这里必须手动传入组件的名称。
     * @param componentName 
     */
    export function register(componentName: string) {
        return function (ctor: ComponentConstructor) {
            if (ctor.tid === -1) {
                ctor.tid = compTid++;
                ctor.compName = componentName;
                componentConstructors.push(ctor);
                componentPools[ctor.tid] = [];
                componentAddOrRemove[ctor.tid] = [];
            }
            else {
                throw new Error('already contain component ' + componentName);
            }
        }
    }
    //#endregion

    //#region context
    /**
     * 组件缓存池
     */
    let componentPools: { [key: string]: IComponent[] } = Object.create(null);

    /**
     * 实体对象缓存池
     */
    let entityPool: Entity[] = [];

    /**
     * 通过实体id查找实体对象
     */
    let eid2Entity: Map<number, Entity> = new Map();

    /**
     * 每个组件的添加和删除的动作都要派送到“关心”它们的group上。
     */
    let componentAddOrRemove: { [key: string]: ComponentAddOrRemove[] } = Object.create(null);

    let groups: Map<string, Group> = new Map();

    /**
     * 实体自增id
     */
    let eid = 1;

    /**
     * 创建实体
     */
    export function createEntity<E extends Entity = Entity>(): E {
        let entity = entityPool.pop() || new Entity();
        entity.eid = eid++;
        eid2Entity.set(entity.eid, entity);
        return entity as E;
    }

    /**
     * 创建组件对象
     * @param ctor
     */
    function createComponent<T extends IComponent>(ctor: ComponentConstructor<T>): T {
        let component = componentPools[ctor.tid].pop() || new componentConstructors[ctor.tid];
        return component as T;
    }

    /**
     * 指定一个组件创建实体，返回组件对象。
     * @param ctor 
     */
    export function createEntityWithComp<T extends IComponent>(ctor: ComponentConstructor<T>): T {
        let entity = createEntity();
        return entity.add(ctor);
    }

    /**
     * 指定多个组件创建实体，返回实体对象。
     * @param ctors 
     */
    export function createEntityWithComps<E extends Entity = Entity>(...ctors: ComponentConstructor<IComponent>[]): E {
        let entity = createEntity();
        for (let ctor of ctors) {
            entity.add(ctor);
        }
        return entity as E;
    }

    /**
     * 销毁实体。
     * 
     * 缓存销毁的实体，下次新建实体时会优先从缓存中拿。
     * @param entity 
     */
    function destroyEntity(entity: Entity) {
        if (eid2Entity.has(entity.eid)) {
            entityPool.push(entity);
            eid2Entity.delete(entity.eid);
        }
        else {
            console.warn('实体没有通过Context对象的createEntity创建或者该实体重复销毁', entity.eid);
        }
    }

    
    type SystemType = 'c' | 'e' | 'r';
    /**
     * 创建group，每个group只关心对应组件的添加和删除
     * @param matchCompTypeIds 
     * @param systemType e-表示ExecuteSystem，r-表示ReactiveSystem，c-表示在系统中自己手动调用createGroup创建的筛选规则
     */
    export function createGroup<E extends Entity = Entity>(matcher: IMatcher, systemType: SystemType = 'c'): Group<E> {
        let key = `${systemType}_${matcher.getKey()}`;
        let group = groups.get(key);
        if (!group) {
            group = new Group(matcher);
            groups.set(key, group);
            let careComponentTypeIds = matcher.indices;
            for (let i = 0, len = careComponentTypeIds.length; i < len; i++) {
                componentAddOrRemove[careComponentTypeIds[i]].push(group.onComponentAddOrRemove.bind(group));
            }
        }
        return group as Group<E>;
    }

    /**
     * 清理所有的实体
     */
    export function clear() {
        eid2Entity.forEach((entity) => {
            entity.destroy();
        });
        groups.forEach((group) => {
            group.clear();
        });
    }

    /**
     * 实体身上组件有增删操作，广播通知对应的观察者。
     * @param entity 实体对象
     * @param componentTypeId 组件类型id
     */
    function broadcastComponentAddOrRemove(entity: Entity, componentTypeId: number) {
        let events = componentAddOrRemove[componentTypeId];
        for (let i = events.length - 1; i >= 0; i--) {
            events[i](entity);
        }
        // 判断是不是删了单例组件
        if (tid2comp.has(componentTypeId)) {
            tid2comp.delete(componentTypeId);
        }
    }

    /**
     * 根据实体id获得实体对象
     * @param eid 
     */
    export function getEntityByEid<E extends Entity = Entity>(eid: number): E {
        return eid2Entity.get(eid) as E;
    }

    /**
     * 当前活动中的实体数量
     */
    export function activeEntityCount() {
        return eid2Entity.size;
    }
    //#endregion


    /**
     * 表示只关心这些组件的添加和删除动作。虽然实体可能有这些组件之外的组件，但是它们的添加和删除没有被关注，所以不会存在对关注之外的组件
     * 进行添加操作引发Group重复添加实体。
     * @param args 
     */
    export function allOf(...args: ComponentConstructor<IComponent>[]) {
        return new Matcher().allOf(...args);
    }

    /**
     * 组件间是或的关系，表示关注拥有任意一个这些组件的实体。
     * @param args 组件索引
     */
    export function anyOf(...args: ComponentConstructor<IComponent>[]) {
        return new Matcher().anyOf(...args);
    }

    /**
     * 表示关注只拥有这些组件的实体
     * 
     * 注意：
     *  不是特殊情况不建议使用onlyOf。因为onlyOf会监听所有组件的添加和删除事件。
     * @param args 组件索引
     */
    export function onlyOf(...args: ComponentConstructor<IComponent>[]) {
        return new Matcher().onlyOf(...args);
    }

    /**
     * 不包含指定的任意一个组件
     * 
     * eg.
     *  ecs.excludeOf(A, B);表示不包含组件A或者组件B
     * @param args 
     */
    export function excludeOf(...args: ComponentConstructor<IComponent>[]) {
        return new Matcher().excludeOf(...args);
    }

    //#region 单例组件
    let tid2comp: Map<number, IComponent> = new Map();
    /**
     * 获取单例组件
     * @param ctor 组件类
     */
    export function getSinglton<T extends IComponent>(ctor: ComponentConstructor<T>) {
        if (!tid2comp.has(ctor.tid)) {
            let comp = createEntityWithComp(ctor);
            tid2comp.set(ctor.tid, comp);
        }
        return tid2comp.get(ctor.tid) as T;
    }
    //#endregion

    class Mask {
        private mask: Uint32Array;
        private size: number = 0;

        constructor() {
            let length = Math.ceil(compTid / 31);
            this.mask = new Uint32Array(length);
            this.size = length;
        }

        set(num: number) {
            // https://stackoverflow.com/questions/34896909/is-it-correct-to-set-bit-31-in-javascript
            // this.mask[((num / 32) >>> 0)] |= ((1 << (num % 32)) >>> 0);
            this.mask[((num / 31) >>> 0)] |= (1 << (num % 31));
        }

        delete(num: number) {
            this.mask[((num / 31) >>> 0)] &= ~(1 << (num % 31));
        }

        has(num: number) {
            return !!(this.mask[((num / 31) >>> 0)] & (1 << (num % 31)));
        }

        or(other: Mask) {
            for (let i = 0; i < this.size; i++) {
                // &操作符最大也只能对2^30进行操作，如果对2^31&2^31会得到负数。当然可以(2^31&2^31) >>> 0，这样多了一步右移操作。
                if (this.mask[i] & other.mask[i]) {
                    return true;
                }
            }
            return false;
        }

        and(other: Mask) {
            for (let i = 0; i < this.size; i++) {
                if ((this.mask[i] & other.mask[i]) != this.mask[i]) {
                    return false;
                }
            }
            return true;
        }

        clear() {
            for (let i = 0; i < this.size; i++) {
                this.mask[i] = 0;
            }
        }
    }
    export class Entity {
        /**
         * 实体唯一标识，不要手动修改。
         */
        public eid: number = -1;

        private mask = new Mask();

        /**
         * 当前实体身上附加的组件构造函数
         */
        private compTid2Ctor: Map<number, ComponentConstructor<IComponent>> = new Map();

        constructor() {}

        /**
         * 根据组件id动态创建组件，并通知关心的系统。
         * 
         * 如果实体存在了这个组件，那么会先删除之前的组件然后添加新的。
         * 
         * 注意：不要直接new Component，new来的Component不会从Component的缓存池拿缓存的数据。
         * @param componentTypeId 组件id
         */
        add<T extends IComponent>(ctor: ComponentConstructor<T>): T {

            let componentTypeId = ctor.tid;
            if (this.mask.has(componentTypeId)) {// 判断是否有该组件，如果有则先移除
                this.remove(ctor);
            }
            this.mask.set(componentTypeId);

            // 创建组件对象
            let component = createComponent(ctor);
            // 将组件对象直接附加到实体对象身上，方便直接获取。
            // @ts-ignore
            this[ctor.compName] = component;
            this.compTid2Ctor.set(componentTypeId, ctor);
            // 广播实体添加组件的消息
            broadcastComponentAddOrRemove(this, componentTypeId);

            component.ent = this;

            return component;
        }

        get<T extends IComponent>(ctor: ComponentConstructor<T>): T {
            // @ts-ignore
            return this[ctor.compName];
        }

        has<T extends IComponent>(ctor: ComponentConstructor<T>): boolean {
            return !!this.get(ctor);
        }

        remove<T extends IComponent>(ctor: ComponentConstructor<T>) {
            let componentTypeId = ctor.tid;
            if (this.mask.has(componentTypeId)) {
                // @ts-ignore
                (this[ctor.compName] as IComponent).reset();
                // @ts-ignore
                (this[ctor.compName] as IComponent).ent = null;
                // @ts-ignore
                componentPools[componentTypeId].push(this[ctor.compName]);
                // @ts-ignore
                this[ctor.compName] = null;
                this.mask.delete(componentTypeId);
                broadcastComponentAddOrRemove(this, componentTypeId);
                this.compTid2Ctor.delete(componentTypeId);
            }
        }

        /**
         * 销毁实体，实体会被回收到实体缓存池中。
         */
        destroy() {
            for (let ctor of this.compTid2Ctor.values()) {
                // @ts-ignore
                (this[ctor.compName] as IComponent).reset();
                // @ts-ignore
                (this[ctor.compName] as IComponent).ent = null;
                // @ts-ignore
                componentPools[ctor.tid].push(this[ctor.compName]);
                this.mask.delete(ctor.tid);
                broadcastComponentAddOrRemove(this, ctor.tid);
                // @ts-ignore
                this[ctor.compName] = null;
            }
            this.compTid2Ctor.clear();
            this.mask.clear();
            destroyEntity(this);
        }
    }

    export class Group<E extends Entity = Entity> {
        /**
         * 实体筛选规则
         */
        private matcher: IMatcher;

        private _matchEntities: Map<number, E> = new Map();

        private _entitiesCache: E[] | null = null;

        /**
         * 符合规则的实体
         */
        public get matchEntities() {
            if (this._entitiesCache === null) {
                this._entitiesCache = Array.from(this._matchEntities.values());
            }
            return this._entitiesCache;
        }

        /**
         * 当前group中实体的数量。
         * 
         * 不要手动修改这个属性值。
         */
        public count = 0; // 其实可以通过this._matchEntities.size获得实体数量，但是需要封装get方法。为了减少一次方法的调用所以才直接创建一个count属性

        /**
         * 获取matchEntities中第一个实体
         */
        get entity(): E {
            return this.matchEntities[0];
        }

        /**
         * 与Group关联的System
         */
        public system: ComblockSystem | null = null;

        constructor(matcher: IMatcher) {
            this.matcher = matcher;
        }

        /**
         * 实体添加或删除组件回调
         * @param entity 
         * @param ctid 组件id；如果实体添加组件，是不需要传ctid，那么它的默认值就是-1；如果实体移除组件，则会传递被移除组件的组件类型id过来
         */
        onComponentAddOrRemove(entity: E) {
            if (this.matcher.isMatch(entity)) { // Group只关心指定组件在实体身上的添加和删除动作。
                this._matchEntities.set(entity.eid, entity);
                this._entitiesCache = null;
                this.count++;
            }
            else if (this._matchEntities.has(entity.eid)) { // 如果Group中有这个实体，但是这个实体已经不满足匹配规则，则从Group中移除该实体
                this._matchEntities.delete(entity.eid);
                this._entitiesCache = null;
                this.count--;
                // @ts-ignore
                this.system?._removedEntities.push(entity);
            }
        }

        clear() {
            this._matchEntities.clear();
            this._entitiesCache = null;
            this.count = 0;
        }
    }

    abstract class BaseOf {
        protected mask = new Mask();
        public indices: number[] = [];
        constructor(...args: number[]) {
            let componentTypeId = -1;
            let len = args.length;
            for (let i = 0; i < len; i++) {
                componentTypeId = args[i];
                if (componentTypeId == -1) {
                    throw Error('存在没有注册的组件！');
                }
                this.mask.set(componentTypeId);

                if (this.indices.indexOf(args[i]) < 0) { // 去重
                    this.indices.push(args[i]);
                }
            }
            if (len > 1) {
                this.indices.sort((a, b) => { return a - b; }); // 对组件类型id进行排序，这样关注相同组件的系统就能共用同一个group
            }
        }

        public toString(): string {
            return this.indices.join('-'); // 生成group的key
        }

        public abstract getKey(): string;

        public abstract isMatch(entity: Entity): boolean;
    }

    /**
     * 用于描述包含任意一个这些组件的实体
     */
    class AnyOf extends BaseOf {
        public isMatch(entity: Entity): boolean {
            // @ts-ignore
            return this.mask.or(entity.mask);
        }

        getKey(): string {
            return 'anyOf:' + this.toString();
        }
    }

    /**
     * 用于描述包含了“这些”组件的实体，这个实体除了包含这些组件还可以包含其他组件
     */
    class AllOf extends BaseOf {
        public isMatch(entity: Entity): boolean {
            // @ts-ignore
            return this.mask.and(entity.mask);
        }

        getKey(): string {
            return 'allOf:' + this.toString();
        }
    }

    /**
     * 不包含指定的任意一个组件
     */
    class ExcludeOf extends BaseOf {

        public getKey(): string {
            return 'excludeOf:' + this.toString();
        }

        public isMatch(entity: Entity): boolean {
            // @ts-ignore
            return !this.mask.or(entity.mask);
        }
    }

    export interface IMatcher {
        indices: number[];
        getKey(): string;
        isMatch(entity: Entity): boolean;
    }

    /**
     * 筛选规则间是“与”的关系
     * 比如：ecs.Macher.allOf(...).excludeOf(...)表达的是allOf && excludeOf，即实体有“这些组件” 并且 “没有这些组件”
     */
    class Matcher implements IMatcher {
        protected rules: BaseOf[] = [];
        protected _indices: number[] | null = null;
        /**
         * 匹配器关注的组件索引。在创建Group时，Context根据组件id去给Group关联组件的添加和移除事件。
         */
        public get indices() {
            if (this._indices === null) {
                this._indices = [];
                this.rules.forEach((rule) => {
                    Array.prototype.push.apply(this._indices, rule.indices);
                });
            }
            return this._indices;
        }

        /**
         * 组件间是或的关系，表示关注拥有任意一个这些组件的实体。
         * @param args 组件索引
         */
        public anyOf(...args: ComponentConstructor<IComponent>[]): Matcher {
            let newArgs = [];
            for (let i = 0, len = args.length; i < len; i++) {
                newArgs.push(args[i].tid);
            }
            this.rules.push(new AnyOf(...newArgs));
            return this;
        }

        /**
         * 组件间是与的关系，表示关注拥有所有这些组件的实体。
         * @param args 组件索引
         */
        public allOf(...args: ComponentConstructor<IComponent>[]): Matcher {
            let newArgs = [];
            for (let i = 0, len = args.length; i < len; i++) {
                newArgs.push(args[i].tid);
            }
            this.rules.push(new AllOf(...newArgs));
            return this;
        }

        /**
         * 表示关注只拥有这些组件的实体
         * 
         * 注意：
         *  不是特殊情况不建议使用onlyOf。因为onlyOf会监听所有组件的添加和删除事件。
         * @param args 组件索引
         */
        public onlyOf(...args: ComponentConstructor<IComponent>[]): Matcher {
            let newArgs = [];
            for (let i = 0, len = args.length; i < len; i++) {
                newArgs.push(args[i].tid);
            }
            this.rules.push(new AllOf(...newArgs));
            let ctors = componentConstructors;
            let otherTids = [];
            for (let ctor of ctors) {
                if (newArgs.indexOf(ctor.tid) < 0) {
                    otherTids.push(ctor.tid);
                }
            }
            this.rules.push(new ExcludeOf(...otherTids));
            return this;
        }

        /**
         * 不包含指定的任意一个组件
         * @param args 
         */
        public excludeOf(...args: ComponentConstructor<IComponent>[]) {
            let newArgs = [];
            for (let i = 0, len = args.length; i < len; i++) {
                newArgs.push(args[i].tid);
            }
            this.rules.push(new ExcludeOf(...newArgs));
            return this;
        }

        public getKey(): string {
            let s = '';
            for (let i = 0; i < this.rules.length; i++) {
                s += this.rules[i].getKey()
                if (i < this.rules.length - 1) {
                    s += ' && '
                }
            }
            return s;
        }

        public isMatch(entity: Entity): boolean {
            if (this.rules.length === 1) {
                return this.rules[0].isMatch(entity);
            }
            else if (this.rules.length === 2) {
                return this.rules[0].isMatch(entity) && this.rules[1].isMatch(entity);
            }
            else {
                for (let rule of this.rules) {
                    if (!rule.isMatch(entity)) {
                        return false;
                    }
                }
                return true;
            }
        }
    }

    //#region System
    /**
     * 如果需要监听实体首次进入System的情况，实现这个接口。
     * 
     * entityEnter会在update方法之前执行，实体进入后，不会再次进入entityEnter方法中。
     * 当实体从当前System移除，下次再次符合条件进入System也会执行上述流程。
     */
    export interface IEntityEnterSystem<E extends Entity = Entity> {
        entityEnter(entities: E[]): void;
    }

    /**
     * 如果需要监听实体从当前System移除，需要实现这个接口。
     */
    export interface IEntityRemoveSystem<E extends Entity = Entity> {
        entityRemove(entities: E[]): void;
    }

    export abstract class ComblockSystem<E extends Entity = Entity> {
        protected group: Group<E>;
        private readonly rGroup: Group<E> | null = null;
        protected dt: number = 0;

        private _removedEntities: E[] | null = null;

        execute!: (dt: number) => void;

        constructor() {
            this.group = createGroup(this.filter(), 'e');

            let hasOwnProperty = Object.hasOwnProperty;
            let prototype = Object.getPrototypeOf(this);
            let hasEntityEnter = hasOwnProperty.call(prototype, 'entityEnter');
            let hasEntityRemove = hasOwnProperty.call(prototype, 'entityRemove');

            if(hasEntityEnter && hasEntityRemove) {
                this.rGroup = createGroup(this.filter(), 'r');
                this.group.system = this;
                this._removedEntities = [];
                this.execute = this.execute3;
            }
            else if(hasEntityEnter && !hasEntityRemove) {
                this.rGroup = createGroup(this.filter(), 'r');
                this.execute = this.execute1;
            }
            else if(!hasEntityEnter && hasEntityRemove) {
                this.group.system = this;
                this._removedEntities = [];
                this.execute = this.execute2;
            }
            else {
                this.execute = this.execute0;
            }
        }

        init(): void {

        }

        hasEntity(): boolean {
            return this.group.count > 0;
        }

        /**
         * 只执行update
         * @param dt 
         * @returns 
         */
        private execute0(dt: number): void {
            if(this.group.count === 0) {
                return;
            }
            this.dt = dt;
            this.update(this.group.matchEntities);
        }

        /**
         * 如果有新的Entity加入，则先执行entityEnter，然后执行update
         * @param dt 
         * @returns 
         */
        private execute1(dt: number): void {
            if(this.group.count === 0) {
                return;
            }
            this.dt = dt;
            // 处理刚进来的实体
            if (this.rGroup!.count > 0) {
                (this as unknown as IEntityEnterSystem).entityEnter(this.rGroup!.matchEntities as E[]);
                this.rGroup!.clear();
            }
            this.update(this.group.matchEntities as E[]);
        }

        /**
         * 如果有Entity不满足条件被移除了，则先执行update，在执行entityRemove。如果是在update执行后被移除的，
         * 那么在下次执行execute的时候，如果_removedEntities里面有Entity，则会执行一次entityRemove。
         * @param dt 
         * @returns 
         */
        private execute2(dt: number): void {
            if(this.group.count === 0) {
                if(this._removedEntities && this._removedEntities.length > 0) {
                    (this as unknown as IEntityRemoveSystem).entityRemove(this._removedEntities);
                    this._removedEntities.length = 0;
                }
                return;
            }
            this.dt = dt;
            this.update(this.group.matchEntities as E[]);
            if(this._removedEntities && this._removedEntities.length > 0) {
                (this as unknown as IEntityRemoveSystem).entityRemove(this._removedEntities);
                this._removedEntities.length = 0;
            }
        }

        /**
         * 先执行entityEnter，在执行update，最后执行entityRemove。
         * @param dt 
         * @returns 
         */
        private execute3(dt: number): void {
            if(this.group.count === 0) {
                if(this._removedEntities && this._removedEntities.length > 0) {
                    (this as unknown as IEntityRemoveSystem).entityRemove(this._removedEntities);
                    this._removedEntities.length = 0;
                }
                return;
            }
            this.dt = dt;
            // 处理刚进来的实体
            if (this.rGroup!.count > 0) {
                (this as unknown as IEntityEnterSystem).entityEnter(this.rGroup!.matchEntities as E[]);
                this.rGroup!.clear();
            }
            this.update(this.group.matchEntities as E[]);
            if(this._removedEntities && this._removedEntities.length > 0) {
                (this as unknown as IEntityRemoveSystem).entityRemove(this._removedEntities);
                this._removedEntities.length = 0;
            }
        }

        /**
         * 实体过滤规则
         * 
         * 根据提供的组件过滤实体。
         */
        abstract filter(): IMatcher;
        abstract update(entities: E[]): void;
    }

    /**
     * System的root，对游戏中的System遍历从这里开始。
     * 
     * 一个System组合中只能有一个RootSystem，可以有多个并行的RootSystem。
     */
    export class RootSystem {
        private executeSystemFlows: ComblockSystem[] = [];
        private systemCnt: number = 0;

        add(system: System | ComblockSystem){
            if(system instanceof System) {
                // 将嵌套的System都“摊平”，放在根System中进行遍历，减少execute的频繁进入退出。
                Array.prototype.push.apply(this.executeSystemFlows, system.comblockSystems);
            }
            else {
                this.executeSystemFlows.push(system as ComblockSystem);
            }
            this.systemCnt = this.executeSystemFlows.length;
            return this;
        }

        init() {
            for (let i = 0; i < this.systemCnt; i++) {
                this.executeSystemFlows[i].init();
            }
        }

        execute(dt: number) {
            for (let i = 0; i < this.systemCnt; i++) {
                this.executeSystemFlows[i].execute(dt);
            }
        }
    }

    /**
     * 系统组合器，用于将多个相同功能模块的系统逻辑上放在一起。System也可以嵌套System。
     */
    export class System {
        private _comblockSystems: ComblockSystem[] = [];
        get comblockSystems() {
            return this._comblockSystems;
        }

        add(system: System | ComblockSystem) {
            if (system instanceof System) {
                Array.prototype.push.apply(this._comblockSystems, system._comblockSystems);
                system._comblockSystems.length = 0;
            }
            else {
                this._comblockSystems.push(system as ComblockSystem);
            }
            return this;
        }
    }
    //#endregion
}