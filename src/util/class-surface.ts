/*
 * The public surface of a class, for proving that an implementation matches a
 * declaration both ways. A class with private fields ("#name") is branded by
 * them, so two classes that both have them are never assignable to each other
 * as written; mapping over their keys keeps every public member and drops the
 * brand.
 */

type Constructor = abstract new (...args: never[]) => object;

type Checkable = { isInstance: (...args: never[]) => boolean };

/**
 * A method's type as a function type of its own. Signatures declared as
 * methods have their parameters compared in either direction even under
 * strictFunctionTypes, so a method that accepts less than its declaration
 * would still pass; a function type written here is compared strictly.
 * An overloaded method keeps its last signature, on both sides alike.
 */
type StrictMember<Member> = Member extends (...args: infer Parameters) => infer Result ? (...args: Parameters) => Result : Member;

/**
 * A member that holds an instance of another class with private fields,
 * compared by that class's own surface, since the brand would otherwise keep
 * an implementation from ever matching its declaration. Whatever else the
 * member may hold, such as undefined, is kept as it is.
 */
type NestedSurface<Member> = Member extends object ? InstanceSurface<Member> : Member;

/**
 * Every public member of an instance, each method compared strictly, and the
 * members named as nested compared by their own surfaces.
 */
export type InstanceSurface<Instance, Nested extends keyof Instance = never> = {
	[Name in keyof Instance]: Name extends Nested ? NestedSurface<Instance[Name]> : StrictMember<Instance[Name]>
};

/**
 * Every public static member, the constructor's parameters and the public
 * members of what it builds, those named as nested by their own surfaces.
 * isInstance is reduced to its parameters, since its type predicate names
 * the branded class.
 */
export type ClassSurface<Class extends Constructor & Checkable, Nested extends keyof InstanceType<Class> = never> =
	{ [Name in keyof Class as Exclude<Name, 'prototype' | 'isInstance'>]: StrictMember<Class[Name]> } &
	{
		isInstance: (...args: Parameters<Class['isInstance']>) => boolean;
		new (...args: ConstructorParameters<Class>): InstanceSurface<InstanceType<Class>, Nested>;
	};
