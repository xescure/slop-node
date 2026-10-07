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

/** Every public member of an instance, each method compared strictly. */
export type InstanceSurface<Instance> = { [Name in keyof Instance]: StrictMember<Instance[Name]> };

/**
 * Every public static member, the constructor's parameters and the public
 * members of what it builds. isInstance is reduced to its parameters, since
 * its type predicate names the branded class.
 */
export type ClassSurface<Class extends Constructor & Checkable> =
	{ [Name in keyof Class as Exclude<Name, 'prototype' | 'isInstance'>]: StrictMember<Class[Name]> } &
	{
		isInstance: (...args: Parameters<Class['isInstance']>) => boolean;
		new (...args: ConstructorParameters<Class>): InstanceSurface<InstanceType<Class>>;
	};
