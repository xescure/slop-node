/*
 * The public surface of a class, for proving that an implementation matches a
 * declaration both ways. A class with private fields ("#name") is branded by
 * them, so two classes that both have them are never assignable to each other
 * as written; mapping over their keys keeps every public member and drops the
 * brand.
 */

type Constructor = abstract new (...args: never[]) => object;

type Checkable = { isInstance: (...args: never[]) => boolean };

/** Every public member of an instance. */
export type InstanceSurface<Instance> = { [Name in keyof Instance]: Instance[Name] };

/**
 * Every public static member, the constructor's parameters and the public
 * members of what it builds. isInstance is reduced to its parameters, since
 * its type predicate names the branded class.
 */
export type ClassSurface<Class extends Constructor & Checkable> =
	{ [Name in keyof Class as Exclude<Name, 'prototype' | 'isInstance'>]: Class[Name] } &
	{
		isInstance: (...args: Parameters<Class['isInstance']>) => boolean;
		new (...args: ConstructorParameters<Class>): InstanceSurface<InstanceType<Class>>;
	};
